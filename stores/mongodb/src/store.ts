import { v7 as uuidv7 } from 'uuid'
import {
  BreadError,
  encodeLastOutput,
  readMigrationStatus,
  requireExecutionId,
  runMigrations,
  type BreadStore,
  type CheckpointRecord,
  type CleanupOptions,
  type CrumbLogEntry,
  type DocumentRecord,
  type LoopIteration,
  type LoopRecord,
  type Principal,
  type TaskRunRecord,
} from '@breadai/core'
import { MongoClient, type ClientSession, type Document } from 'mongodb'
import { mongoCode, queryFailed, scrub } from './fail.js'
import {
  boundedLimit,
  filterString,
  finiteInteger,
  keywordPattern,
  requiredString,
  storedPrincipal,
  tagPairs,
  type TagPair,
} from './guards.js'
import { mongoMigration } from './migrate.js'
import {
  CHECKPOINTS,
  CRUMBS,
  DOCUMENTS,
  LOOP_ITERATIONS,
  LOOPS,
  MEMORIES,
  MESSAGES,
  SESSIONS,
  TASK_RUNS,
} from './names.js'
import {
  toCheckpoint,
  toCrumb,
  toIteration,
  toLoop,
  toMemory,
  toMessage,
  toSession,
  toTaskRun,
} from './rows.js'
import { mongoClientOptions, resolveMongoUrl } from './url.js'

interface Row extends Document {
  _id: string
}

export interface MongoStoreOptions {
  // Connection string. Defaults to process.env.MONGODB_URL. Nothing else supplies
  // the host, user, or password. Cleartext and no auth need `loopback: true`
  // and a loopback host.
  url?: string
  loopback?: boolean
}

type Doc = Record<string, unknown>

function tagClause(pairs: TagPair[] | undefined): Document | undefined {
  if (!pairs || pairs.length === 0) return undefined
  return { $all: pairs.map((pair) => ({ $elemMatch: { k: pair.k, v: pair.v } })) }
}

function ownerFilter(agentId: unknown, principal: Principal): Document {
  return {
    agent_id: requiredString(agentId, 'INVALID_ID'),
    principal_iss: requiredString(principal?.iss, 'INVALID_PRINCIPAL'),
    principal_sub: requiredString(principal?.sub, 'INVALID_PRINCIPAL'),
  }
}

function checkpointFields(record: CheckpointRecord): Document {
  return {
    agent_id: requiredString(record.agentId, 'INVALID_ID'),
    run_id: requiredString(record.runId, 'INVALID_ID'),
    session_id: requiredString(record.sessionId, 'INVALID_ID'),
    execution_id: record.executionId,
    tool_name: requiredString(record.toolName, 'INVALID_ID'),
    tool_call_id: requiredString(record.toolCallId, 'INVALID_ID'),
    schema: record.schema ?? null,
    prompt: record.prompt ?? null,
    skill: record.skill ?? null,
    parent: record.parent ?? null,
    pending: record.pending ?? null,
    principal: record.principal != null ? storedPrincipal(record.principal) : null,
    created_at: record.createdAt,
  }
}

function asDoc(value: unknown): Doc | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ('ok' in value && 'value' in value) {
    const inner = (value as { value?: unknown }).value
    if (!inner || typeof inner !== 'object') return undefined
    return inner as Doc
  }
  return value as Doc
}

export function store(opts: MongoStoreOptions = {}): BreadStore {
  const endpoint = resolveMongoUrl(opts.url ?? process.env.MONGODB_URL, opts.loopback === true)
  let client: MongoClient
  try {
    client = new MongoClient(endpoint.url, mongoClientOptions(endpoint, 10))
  } catch (err) {
    throw new BreadError('MongoDB URL is not allowed.', 'STORE_URL_REJECTED', {}, scrub(err))
  }
  const db = client.db()
  const sessions = db.collection<Row>(SESSIONS)
  const messages = db.collection<Row>(MESSAGES)
  const checkpoints = db.collection<Row>(CHECKPOINTS)
  const loops = db.collection<Row>(LOOPS)
  const iterations = db.collection<Row>(LOOP_ITERATIONS)
  const memories = db.collection<Row>(MEMORIES)
  const documents = db.collection<Row>(DOCUMENTS)
  const crumbs = db.collection<Row>(CRUMBS)
  const taskRuns = db.collection<Row>(TASK_RUNS)

  let ready = false
  let transactions: boolean | undefined

  async function assertSchema(): Promise<void> {
    if (ready) return
    const found = await db.listCollections({ name: SESSIONS }, { nameOnly: true }).hasNext()
    if (!found) throw new BreadError('Store schema is not ready.', 'MIGRATIONS_PENDING')
    ready = true
  }

  async function supportsTransactions(): Promise<boolean> {
    if (transactions !== undefined) return transactions
    const hello = await db.command({ hello: 1 })
    const replica = hello as { setName?: unknown; msg?: unknown }
    transactions = typeof replica.setName === 'string' || replica.msg === 'isdbgrid'
    return transactions
  }

  function tx(session: ClientSession | undefined): { session: ClientSession } | Record<string, never> {
    return session ? { session } : {}
  }

  async function withTx<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
    if (!(await supportsTransactions())) return fn(undefined)
    const session = client.startSession()
    try {
      let value!: T
      await session.withTransaction(async () => {
        value = await fn(session)
      })
      return value
    } finally {
      await session.endSession()
    }
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await assertSchema()
      return await fn()
    } catch (err) {
      queryFailed(err)
    }
  }

  async function cascade(ids: readonly string[], session: ClientSession | undefined): Promise<void> {
    if (ids.length === 0) return
    const filter = { session_id: { $in: [...ids] } }
    const options = tx(session)
    await messages.deleteMany(filter, options)
    await checkpoints.deleteMany(filter, options)
    await crumbs.deleteMany(filter, options)
  }

  async function removeSessions(filter: Document): Promise<number> {
    return withTx(async (session) => {
      const options = tx(session)
      const found = await sessions.find(filter, { projection: { _id: 1 }, ...options }).toArray()
      const ids = found.map((doc) => doc._id)
      if (ids.length === 0) return 0
      await sessions.deleteMany({ $and: [filter, { _id: { $in: ids } }] }, options)
      const left = await sessions.find({ _id: { $in: ids } }, { projection: { _id: 1 }, ...options }).toArray()
      const stay = new Set(left.map((doc) => doc._id))
      const gone = ids.filter((id) => !stay.has(id))
      await cascade(gone, session)
      return gone.length
    })
  }

  async function upsertCheckpoint(record: CheckpointRecord, session?: ClientSession): Promise<void> {
    requireExecutionId(record.executionId, 'saveCheckpoint')
    await checkpoints.updateOne(
      { _id: requiredString(record.id, 'INVALID_ID') },
      { $set: checkpointFields(record), $setOnInsert: { claimed: 0 } },
      { upsert: true, ...tx(session) },
    )
  }

  function one(result: unknown): Doc | undefined {
    return asDoc(result)
  }

  const breadStore: BreadStore = {
    async createSession(input) {
      return run(async () => {
        const id = input?.id === undefined ? uuidv7() : requiredString(input.id, 'INVALID_ID')
        const now = Date.now()
        const tags = tagPairs(input?.tags) ?? []
        const principal = input?.principal != null ? storedPrincipal(input.principal) : null
        try {
          await sessions.insertOne({
            _id: id,
            created_at: now,
            updated_at: now,
            agent_id: null,
            tags,
            principal,
          })
        } catch (err) {
          if (mongoCode(err) === 11000) throw new BreadError('Session already exists.', 'SESSION_EXISTS')
          throw err
        }
        return {
          id,
          createdAt: now,
          updatedAt: now,
          tags: Object.fromEntries(tags.map((pair) => [pair.k, pair.v])),
          ...(principal ? { principal } : {}),
        }
      })
    },

    async claimSessionPrincipal(id, principal) {
      return run(async () => {
        const result = await sessions.updateOne(
          { _id: requiredString(id, 'INVALID_ID'), principal: null },
          { $set: { principal: storedPrincipal(principal) } },
        )
        return result.matchedCount === 1
      })
    },

    async getSession(id) {
      return run(async () => {
        const doc = await sessions.findOne({ _id: requiredString(id, 'INVALID_ID') })
        return doc ? toSession(doc) : undefined
      })
    },

    async listSessions(filter) {
      return run(async () => {
        const tags = tagClause(tagPairs(filter?.tags))
        const query: Document = tags ? { tags } : {}
        const docs = await sessions.find(query).toArray()
        return docs.map((doc) => toSession(doc))
      })
    },

    async deleteSession(id) {
      return run(async () => {
        const sessionId = requiredString(id, 'INVALID_ID')
        await removeSessions({ _id: sessionId })
      })
    },

    async deleteSessionForPrincipal(id, principal) {
      return run(async () => {
        const removed = await removeSessions({
          _id: requiredString(id, 'INVALID_ID'),
          'principal.iss': requiredString(principal?.iss, 'INVALID_PRINCIPAL'),
          'principal.sub': requiredString(principal?.sub, 'INVALID_PRINCIPAL'),
        })
        return removed === 1
      })
    },

    async cleanupSessions(options?: CleanupOptions) {
      return run(async () => {
        if (typeof options?.olderThanMs !== 'number' || !(options.olderThanMs > 0)) return 0
        const filter: Document = { updated_at: { $lt: Date.now() - options.olderThanMs } }
        const tags = tagClause(tagPairs(options.tags))
        if (tags) filter.tags = tags
        if (options.principal) {
          filter['principal.iss'] = requiredString(options.principal.iss, 'INVALID_PRINCIPAL')
          filter['principal.sub'] = requiredString(options.principal.sub, 'INVALID_PRINCIPAL')
        }
        return removeSessions(filter)
      })
    },

    async getMessages(sessionId) {
      return run(async () => {
        const docs = await messages
          .find({ session_id: requiredString(sessionId, 'INVALID_ID') })
          .sort({ timestamp: 1, _id: 1 })
          .toArray()
        return docs.map((doc) => toMessage(doc))
      })
    },

    async addMessage(sessionId, message) {
      return run(async () => {
        const id = requiredString(sessionId, 'INVALID_ID')
        const now = message.timestamp ?? Date.now()
        const updated = await sessions.updateOne({ _id: id }, { $set: { updated_at: now } })
        if (updated.matchedCount !== 1) throw new BreadError('Session not found.', 'SESSION_NOT_FOUND')
        await messages.insertOne({
          _id: uuidv7(),
          session_id: id,
          role: message.role,
          content: message.content ?? null,
          timestamp: now,
        })
      })
    },

    async saveCheckpoint(record) {
      return run(async () => {
        await upsertCheckpoint(record)
      })
    },

    async getCheckpoint(id) {
      return run(async () => {
        const doc = await checkpoints.findOne({ _id: requiredString(id, 'INVALID_ID') })
        return doc ? toCheckpoint(doc) : undefined
      })
    },

    async claimCheckpoint(id) {
      return run(async () => {
        const doc = await checkpoints.findOneAndUpdate(
          { _id: requiredString(id, 'INVALID_ID'), claimed: 0 },
          { $set: { claimed: 1 } },
          { returnDocument: 'after' },
        )
        const row = one(doc)
        return row ? toCheckpoint(row) : undefined
      })
    },

    async deleteCheckpoint(id, options) {
      return run(async () => {
        const filter: Document = { _id: requiredString(id, 'INVALID_ID') }
        if (options?.unclaimedOnly) filter.claimed = 0
        const doc = await checkpoints.findOneAndDelete(filter)
        const row = one(doc)
        return row ? toCheckpoint(row) : undefined
      })
    },

    async listCheckpoints(filter) {
      return run(async () => {
        const executionId = filter && requireExecutionId(filter.executionId, 'listCheckpoints')
        const query: Document = executionId === undefined ? {} : { execution_id: executionId }
        const docs = await checkpoints.find(query).sort({ created_at: 1 }).toArray()
        return docs.map((doc) => toCheckpoint(doc))
      })
    },

    async suspendRun(sessionId, msgs, checkpoint) {
      return run(async () => {
        requireExecutionId(checkpoint.executionId, 'suspendRun')
        const id = requiredString(sessionId, 'INVALID_ID')
        await withTx(async (session) => {
          const options = tx(session)
          let last = checkpoint.createdAt
          for (const message of msgs) {
            const now = message.timestamp ?? Date.now()
            await messages.insertOne(
              {
                _id: uuidv7(),
                session_id: id,
                role: message.role,
                content: message.content ?? null,
                timestamp: now,
              },
              options,
            )
            last = now
          }
          await sessions.updateOne({ _id: id }, { $set: { updated_at: last } }, options)
          await upsertCheckpoint(checkpoint, session)
        })
      })
    },

    async createLoop(record) {
      return run(async () => {
        await loops.insertOne({
          _id: requiredString(record.id, 'INVALID_ID'),
          agent_id: requiredString(record.agentId, 'INVALID_ID'),
          session_id: requiredString(record.sessionId, 'INVALID_ID'),
          run_id: requiredString(record.runId, 'INVALID_ID'),
          pool: record.pool,
          pipeline: record.pipeline,
          max_iterations: record.maxIterations,
          status: record.status,
          iterations: record.iterations,
          result: record.result === undefined ? null : record.result,
          started_at: record.startedAt,
          completed_at: record.completedAt ?? null,
        })
      })
    },

    async updateLoop(id, patch) {
      return run(async () => {
        const set: Document = {}
        if (patch.status !== undefined) set.status = filterString(patch.status)
        if (patch.iterations !== undefined) set.iterations = finiteInteger(patch.iterations, 'INVALID_FILTER')
        if (patch.result !== undefined) set.result = patch.result
        if (Object.prototype.hasOwnProperty.call(patch, 'lastOutput')) {
          set.last_output = encodeLastOutput(patch.lastOutput)
        }
        if (patch.completedAt !== undefined) set.completed_at = patch.completedAt
        if (Object.keys(set).length === 0) return
        await loops.updateOne({ _id: requiredString(id, 'INVALID_ID') }, { $set: set })
      })
    },

    async addLoopIteration(iteration) {
      return run(async () => {
        const row: LoopIteration = iteration
        await iterations.insertOne({
          _id: requiredString(row.id, 'INVALID_ID'),
          loop_id: requiredString(row.loopId, 'INVALID_ID'),
          idx: row.index,
          input: row.input === undefined ? null : row.input,
          output: row.output === undefined ? null : row.output,
          started_at: row.startedAt,
          completed_at: row.completedAt,
        })
      })
    },

    async getLoop(id) {
      return run(async () => {
        const loopId = requiredString(id, 'INVALID_ID')
        const doc = await loops.findOne({ _id: loopId })
        if (!doc) return undefined
        const rows = await iterations.find({ loop_id: loopId }).sort({ idx: 1 }).toArray()
        return { loop: toLoop(doc), iterations: rows.map((row) => toIteration(row)) }
      })
    },

    async listLoops(filter) {
      return run(async () => {
        const query: Document = {}
        if (filter?.sessionId !== undefined) query.session_id = filterString(filter.sessionId)
        if (filter?.agentId !== undefined) query.agent_id = filterString(filter.agentId)
        if (filter?.status !== undefined) query.status = filterString(filter.status)
        const docs = await loops.find(query).sort({ started_at: -1 }).toArray()
        return docs.map((doc) => toLoop(doc))
      })
    },

    async createTaskRun(record) {
      return run(async () => {
        const row: TaskRunRecord = record
        await taskRuns.insertOne({
          _id: requiredString(row.id, 'INVALID_ID'),
          task_id: requiredString(row.taskId, 'INVALID_ID'),
          agent_id: row.agentId ?? null,
          session_id: row.sessionId ?? null,
          run_id: row.runId ?? null,
          model: row.model,
          input: row.input === undefined ? null : row.input,
          output: row.output === undefined ? null : row.output,
          status: row.status,
          usage: row.usage === undefined ? null : row.usage,
          error: row.error ?? null,
          duration_ms: row.durationMs ?? null,
          created_at: row.createdAt,
          completed_at: row.completedAt ?? null,
        })
      })
    },

    async finishTaskRun(id, patch) {
      return run(async () => {
        const set: Document = {}
        if (patch.status !== undefined) set.status = filterString(patch.status)
        if (patch.output !== undefined) set.output = patch.output
        if (patch.usage !== undefined) set.usage = patch.usage
        if (patch.error !== undefined) set.error = filterString(patch.error)
        if (patch.durationMs !== undefined) set.duration_ms = finiteInteger(patch.durationMs, 'INVALID_FILTER')
        if (patch.completedAt !== undefined) set.completed_at = patch.completedAt
        if (Object.keys(set).length === 0) return
        await taskRuns.updateOne({ _id: requiredString(id, 'INVALID_ID') }, { $set: set })
      })
    },

    async getTaskRun(id) {
      return run(async () => {
        const doc = await taskRuns.findOne({ _id: requiredString(id, 'INVALID_ID') })
        return doc ? toTaskRun(doc) : undefined
      })
    },

    async listTaskRuns(filter) {
      return run(async () => {
        const query: Document = {}
        if (filter?.taskId !== undefined) query.task_id = filterString(filter.taskId)
        if (filter?.agentId !== undefined) query.agent_id = filterString(filter.agentId)
        if (filter?.sessionId !== undefined) query.session_id = filterString(filter.sessionId)
        if (filter?.status !== undefined) query.status = filterString(filter.status)
        const cursor = taskRuns.find(query).sort({ created_at: -1 })
        const limited = filter?.limit !== undefined ? cursor.limit(boundedLimit(filter.limit, filter.limit)) : cursor
        const docs = await limited.toArray()
        return docs.map((doc) => toTaskRun(doc))
      })
    },

    async appendCrumbs(entries) {
      return run(async () => {
        if (entries.length === 0) return
        const docs = entries.map((entry: CrumbLogEntry) => ({
          _id: uuidv7(),
          run_id: requiredString(entry.runId, 'INVALID_ID'),
          seq: finiteInteger(entry.seq, 'INVALID_SEQ'),
          session_id: entry.sessionId === undefined ? null : requiredString(entry.sessionId, 'INVALID_ID'),
          agent_id: entry.agentId === undefined ? null : requiredString(entry.agentId, 'INVALID_ID'),
          type: requiredString(entry.type, 'INVALID_FILTER'),
          crumb: entry.crumb,
          created_at: entry.createdAt,
        }))
        await withTx(async (session) => {
          await crumbs.insertMany(docs, { ordered: true, ...tx(session) })
        })
      })
    },

    async getCrumbs(runId, options) {
      return run(async () => {
        const after = options?.afterSeq === undefined ? 0 : finiteInteger(options.afterSeq, 'INVALID_SEQ')
        if (after < 0) throw new BreadError('Expected an integer.', 'INVALID_SEQ')
        const cursor = crumbs
          .find({ run_id: requiredString(runId, 'INVALID_ID'), seq: { $gt: after } })
          .sort({ seq: 1 })
        const limited =
          options?.limit !== undefined ? cursor.limit(boundedLimit(options.limit, options.limit)) : cursor
        const docs = await limited.toArray()
        return docs.map((doc) => toCrumb(doc))
      })
    },

    async getMaxCrumbSeq(runId) {
      return run(async () => {
        const doc = await crumbs
          .find({ run_id: requiredString(runId, 'INVALID_ID') })
          .sort({ seq: -1 })
          .limit(1)
          .next()
        return doc ? finiteInteger(doc.seq, 'INVALID_SEQ') : 0
      })
    },

    async addMemory({ agentId, principal, content }) {
      return run(async () => {
        if (typeof content !== 'string') throw new BreadError('Search query is invalid.', 'INVALID_QUERY')
        const owner = ownerFilter(agentId, principal)
        const id = uuidv7()
        const createdAt = Date.now()
        await memories.insertOne({
          _id: id,
          ...owner,
          content,
          created_at: createdAt,
        })
        return { id, content, createdAt }
      })
    },

    async searchMemories({ agentId, principal, query, limit }) {
      return run(async () => {
        const docs = await memories
          .find({
            ...ownerFilter(agentId, principal),
            content: { $regex: keywordPattern(query), $options: 'i' },
          })
          .sort({ created_at: -1 })
          .limit(boundedLimit(limit, 10))
          .toArray()
        return docs.map((doc) => toMemory(doc))
      })
    },

    async listMemories({ agentId, principal, limit }) {
      return run(async () => {
        const docs = await memories
          .find(ownerFilter(agentId, principal))
          .sort({ created_at: -1 })
          .limit(boundedLimit(limit, 100))
          .toArray()
        return docs.map((doc) => toMemory(doc))
      })
    },

    async forgetMemory({ agentId, principal, id }) {
      return run(async () => {
        const result = await memories.deleteOne({
          _id: requiredString(id, 'INVALID_ID'),
          ...ownerFilter(agentId, principal),
        })
        return { deleted: result.deletedCount === 1 }
      })
    },

    async ingestDocument({ agentId, title, content, source }) {
      return run(async () => {
        const id = uuidv7()
        await documents.insertOne({
          _id: id,
          agent_id: requiredString(agentId, 'INVALID_ID'),
          title: requiredString(title, 'INVALID_FILTER'),
          content: typeof content === 'string' ? content : requiredString(content, 'INVALID_FILTER'),
          source: source ?? null,
          created_at: Date.now(),
        })
        return { id, title }
      })
    },

    async searchDocuments({ agentId, query, limit }) {
      return run(async () => {
        const pattern = keywordPattern(query)
        const docs = await documents
          .find({
            agent_id: requiredString(agentId, 'INVALID_ID'),
            $or: [
              { title: { $regex: pattern, $options: 'i' } },
              { content: { $regex: pattern, $options: 'i' } },
            ],
          })
          .limit(boundedLimit(limit, 5))
          .toArray()
        return docs.map((doc): DocumentRecord => {
          if (typeof doc._id !== 'string' || typeof doc.title !== 'string') {
            throw new BreadError('Store query failed.', 'STORE_QUERY_FAILED')
          }
          return {
            id: doc._id,
            title: doc.title,
            source: typeof doc.source === 'string' ? doc.source : null,
          }
        })
      })
    },

    async readDocument({ agentId, id }) {
      return run(async () => {
        const doc = await documents.findOne({
          _id: requiredString(id, 'INVALID_ID'),
          agent_id: requiredString(agentId, 'INVALID_ID'),
        })
        if (!doc || typeof doc.title !== 'string' || typeof doc.content !== 'string') return undefined
        return { title: doc.title, content: doc.content }
      })
    },

    async migrate() {
      const plan = mongoMigration(endpoint)
      const report = await runMigrations(plan.journal, plan.steps, plan.knownIds)
      ready = true
      return report
    },

    async migrations() {
      const plan = mongoMigration(endpoint)
      return readMigrationStatus(plan.journal, plan.steps, plan.knownIds)
    },

    async close() {
      await client.close()
    },
  }
  return breadStore
}
