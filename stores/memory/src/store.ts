import { v7 as uuidv7 } from 'uuid'
import type {
  BreadStore,
  CheckpointRecord,
  CleanupOptions,
  CrumbLogEntry,
  DocumentRecord,
  KnowledgeNode,
  LoopIteration,
  LoopRecord,
  Session,
  SessionMessage,
  TaskRunRecord,
} from '@breadai/core'

interface KgNode {
  id: string
  agentId: string
  sessionId: string
  label: string
  data: Record<string, unknown>
  createdAt: number
}

interface KgEdge {
  id: string
  fromId: string
  toId: string
  relation: string
}

interface Doc {
  id: string
  agentId: string
  title: string
  content: string
  source: string | null
  createdAt: number
}

// In-process BreadStore backed by plain Maps/arrays. No persistence — state is
// lost when the process exits. Ideal for unit tests and ephemeral runs.
export function store(): BreadStore {
  const sessions = new Map<string, Session>()
  const messages = new Map<string, SessionMessage[]>()
  const checkpoints = new Map<string, CheckpointRecord>()
  const loops = new Map<string, LoopRecord>()
  const loopIterations = new Map<string, LoopIteration[]>()
  const taskRuns = new Map<string, TaskRunRecord>()
  const crumbs = new Map<string, CrumbLogEntry[]>() // keyed by runId
  const nodes: KgNode[] = []
  const edges: KgEdge[] = []
  const docs: Doc[] = []

  // Mirrors the SQL stores' session_id ON DELETE CASCADE for the crumb log.
  function cascadeCrumbs(sessionId: string): void {
    for (const [runId, entries] of crumbs) {
      const kept = entries.filter((e) => e.sessionId !== sessionId)
      if (kept.length === 0) crumbs.delete(runId)
      else if (kept.length !== entries.length) crumbs.set(runId, kept)
    }
  }

  // Mirrors the SQL stores' session_id ON DELETE CASCADE for checkpoints.
  function cascadeCheckpoints(sessionId: string): void {
    for (const [id, cp] of checkpoints) {
      if (cp.sessionId === sessionId) checkpoints.delete(id)
    }
  }

  function matchesTags(session: Session, tags?: Record<string, string>): boolean {
    if (!tags) return true
    return Object.entries(tags).every(([k, v]) => session.tags[k] === v)
  }

  function addMessageSync(sessionId: string, message: Omit<SessionMessage, 'id' | 'sessionId'>): void {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    // v7: sortable, monotonic id so a turn's multiple messages (assistant
    // tool-call + tool-result) keep their order under any consumer.
    messages.get(sessionId)!.push({ ...message, id: uuidv7(), sessionId })
    session.updatedAt = Date.now()
  }

  return {
    // --- Sessions ------------------------------------------------------------
    async createSession(opts) {
      const id = opts?.id ?? uuidv7()
      const now = Date.now()
      const session: Session = { id, createdAt: now, updatedAt: now, tags: opts?.tags ?? {} }
      sessions.set(id, session)
      messages.set(id, [])
      return session
    },

    async getSession(id) {
      return sessions.get(id)
    },

    async listSessions(filter) {
      return [...sessions.values()].filter((s) => matchesTags(s, filter?.tags))
    },

    async deleteSession(id) {
      sessions.delete(id)
      messages.delete(id)
      cascadeCrumbs(id)
      cascadeCheckpoints(id)
    },

    async cleanupSessions(opts?: CleanupOptions) {
      const now = Date.now()
      let count = 0
      for (const [id, session] of sessions) {
        const tooOld = opts?.olderThanMs ? now - session.updatedAt > opts.olderThanMs : false
        if (tooOld && matchesTags(session, opts?.tags)) {
          sessions.delete(id)
          messages.delete(id)
          cascadeCrumbs(id)
          cascadeCheckpoints(id)
          count++
        }
      }
      return count
    },

    async getMessages(sessionId) {
      return messages.get(sessionId) ?? []
    },

    async addMessage(sessionId, message) {
      addMessageSync(sessionId, message)
    },

    // --- Checkpoints ---------------------------------------------------------
    async saveCheckpoint(record) {
      checkpoints.set(record.id, { ...record, schema: record.schema ?? null })
    },

    async getCheckpoint(id) {
      return checkpoints.get(id)
    },

    async deleteCheckpoint(id) {
      const record = checkpoints.get(id)
      checkpoints.delete(id)
      return record
    },

    async listCheckpoints() {
      return [...checkpoints.values()].sort((a, b) => a.createdAt - b.createdAt)
    },

    async suspendRun(sessionId, msgs, checkpoint) {
      for (const m of msgs) addMessageSync(sessionId, m)
      checkpoints.set(checkpoint.id, { ...checkpoint, schema: checkpoint.schema ?? null })
    },

    // --- Loops ---------------------------------------------------------------
    async createLoop(record) {
      loops.set(record.id, { ...record })
      loopIterations.set(record.id, [])
    },

    async updateLoop(id, patch) {
      const loop = loops.get(id)
      if (!loop) throw new Error(`Loop not found: ${id}`)
      Object.assign(loop, patch)
    },

    async addLoopIteration(iteration) {
      const list = loopIterations.get(iteration.loopId)
      if (!list) throw new Error(`Loop not found: ${iteration.loopId}`)
      list.push({ ...iteration })
    },

    async getLoop(id) {
      const loop = loops.get(id)
      if (!loop) return undefined
      return { loop: { ...loop }, iterations: [...(loopIterations.get(id) ?? [])] }
    },

    async listLoops(filter) {
      return [...loops.values()].filter(
        (l) =>
          (!filter?.sessionId || l.sessionId === filter.sessionId) &&
          (!filter?.agentId || l.agentId === filter.agentId) &&
          (!filter?.status || l.status === filter.status),
      )
    },

    // --- Task runs (audit) ---------------------------------------------------
    async createTaskRun(record) {
      taskRuns.set(record.id, { ...record })
    },

    async finishTaskRun(id, patch) {
      const run = taskRuns.get(id)
      if (!run) throw new Error(`Task run not found: ${id}`)
      Object.assign(run, patch)
    },

    async getTaskRun(id) {
      const run = taskRuns.get(id)
      return run ? { ...run } : undefined
    },

    async listTaskRuns(filter) {
      const rows = [...taskRuns.values()]
        .filter(
          (r) =>
            (!filter?.taskId || r.taskId === filter.taskId) &&
            (!filter?.agentId || r.agentId === filter.agentId) &&
            (!filter?.sessionId || r.sessionId === filter.sessionId) &&
            (!filter?.status || r.status === filter.status),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
      return filter?.limit ? rows.slice(0, filter.limit) : rows
    },

    // --- Crumb run-log ---------------------------------------------------------
    async appendCrumbs(entries) {
      for (const entry of entries) {
        let list = crumbs.get(entry.runId)
        if (!list) {
          list = []
          crumbs.set(entry.runId, list)
        }
        list.push({ ...entry })
      }
    },

    async getCrumbs(runId, opts) {
      let rows = [...(crumbs.get(runId) ?? [])].sort((a, b) => a.seq - b.seq)
      if (opts?.afterSeq !== undefined) rows = rows.filter((e) => e.seq > opts.afterSeq!)
      return opts?.limit ? rows.slice(0, opts.limit) : rows
    },

    async getMaxCrumbSeq(runId) {
      const rows = crumbs.get(runId)
      if (!rows || rows.length === 0) return 0
      return rows.reduce((max, e) => (e.seq > max ? e.seq : max), 0)
    },

    // --- Knowledge graph -----------------------------------------------------
    async addKnowledgeNode({ agentId, sessionId, label, data }) {
      const id = uuidv7()
      nodes.push({ id, agentId, sessionId, label, data: data ?? {}, createdAt: Date.now() })
      return { id, label }
    },

    async addKnowledgeEdge({ fromId, toId, relation }) {
      edges.push({ id: uuidv7(), fromId, toId, relation })
    },

    async queryKnowledge({ agentId, query, limit }) {
      const q = query.toLowerCase()
      return nodes
        .filter((n) => n.agentId === agentId && n.label.toLowerCase().includes(q))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? 10)
        .map((n): KnowledgeNode => ({ id: n.id, label: n.label, data: n.data }))
    },

    async forgetKnowledge({ id }) {
      const idx = nodes.findIndex((n) => n.id === id)
      if (idx === -1) return { deleted: false }
      nodes.splice(idx, 1)
      // Drop edges touching the removed node, mirroring ON DELETE CASCADE.
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i]!.fromId === id || edges[i]!.toId === id) edges.splice(i, 1)
      }
      return { deleted: true }
    },

    async knowledgeContext({ agentId, sessionId, limit }) {
      return nodes
        .filter((n) => n.agentId === agentId && n.sessionId === sessionId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? 100)
        .map((n) => ({ label: n.label, data: n.data }))
    },

    // --- Documents -----------------------------------------------------------
    async ingestDocument({ agentId, title, content, source }) {
      const id = uuidv7()
      docs.push({ id, agentId, title, content, source: source ?? null, createdAt: Date.now() })
      return { id, title }
    },

    async searchDocuments({ agentId, query, limit }) {
      const q = query.toLowerCase()
      return docs
        .filter(
          (d) =>
            d.agentId === agentId &&
            (d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)),
        )
        .slice(0, limit ?? 5)
        .map((d): DocumentRecord => ({ id: d.id, title: d.title, source: d.source }))
    },

    async readDocument({ agentId, id }) {
      const d = docs.find((doc) => doc.id === id && doc.agentId === agentId)
      return d ? { title: d.title, content: d.content } : undefined
    },
  }
}
