import { BreadError, migrationChecksum, type MigrationJournal, type MigrationStep } from '@breadai/core'
import { MongoClient, type Db, type Document } from 'mongodb'
import { journalError, mongoCode, scrub } from './fail.js'
import {
  CHECKPOINTS,
  CRUMBS,
  DOCUMENTS,
  isDataCollection,
  JOURNAL,
  LOCK,
  LOCK_ID,
  LOOP_ITERATIONS,
  LOOPS,
  MEMORIES,
  MESSAGES,
  SESSIONS,
  TASK_RUNS,
} from './names.js'
import { mongoClientOptions, type MongoEndpoint } from './url.js'

export const BASELINE_ID = '0001_baseline'

interface IndexSpec {
  name: string
  key: Record<string, 1 | -1>
  unique?: boolean
}

interface CollectionSpec {
  name: string
  indexes: IndexSpec[]
}

export const BASELINE_SPEC: CollectionSpec[] = [
  {
    name: SESSIONS,
    indexes: [{ name: 'idx_bread_sessions_updated', key: { updated_at: 1 } }],
  },
  {
    name: MESSAGES,
    indexes: [{ name: 'idx_bread_messages_session', key: { session_id: 1, timestamp: 1, _id: 1 } }],
  },
  {
    name: CHECKPOINTS,
    indexes: [
      { name: 'idx_bread_checkpoints_session', key: { session_id: 1 } },
      { name: 'idx_bread_checkpoints_execution', key: { execution_id: 1, created_at: 1 } },
    ],
  },
  {
    name: LOOPS,
    indexes: [
      { name: 'idx_bread_loops_session', key: { session_id: 1 } },
      { name: 'idx_bread_loops_agent', key: { agent_id: 1 } },
    ],
  },
  {
    name: LOOP_ITERATIONS,
    indexes: [{ name: 'idx_bread_loop_iterations_loop', key: { loop_id: 1, idx: 1 } }],
  },
  {
    name: MEMORIES,
    indexes: [
      {
        name: 'idx_bread_memories_owner',
        key: { agent_id: 1, principal_iss: 1, principal_sub: 1, created_at: -1 },
      },
    ],
  },
  {
    name: DOCUMENTS,
    indexes: [{ name: 'idx_bread_documents_agent', key: { agent_id: 1 } }],
  },
  {
    name: CRUMBS,
    indexes: [
      { name: 'idx_bread_crumbs_run_seq', key: { run_id: 1, seq: 1 }, unique: true },
      { name: 'idx_bread_crumbs_session', key: { session_id: 1 } },
    ],
  },
  {
    name: TASK_RUNS,
    indexes: [
      { name: 'idx_bread_task_runs_task', key: { task_id: 1, created_at: -1 } },
      { name: 'idx_bread_task_runs_session', key: { session_id: 1 } },
      { name: 'idx_bread_task_runs_agent', key: { agent_id: 1 } },
    ],
  },
]

export const BASELINE_TEXT = JSON.stringify(BASELINE_SPEC)

interface Row extends Document {
  _id: string
}
const BASELINE_CHECKSUM = migrationChecksum(BASELINE_TEXT)

async function collectionExists(db: Db, name: string): Promise<boolean> {
  return db.listCollections({ name }, { nameOnly: true }).hasNext()
}

export async function applyBaseline(db: Db): Promise<void> {
  for (const spec of BASELINE_SPEC) {
    if (!isDataCollection(spec.name)) {
      throw new BreadError('Migration step is invalid.', 'MIGRATION_INVALID', { step: BASELINE_ID })
    }
    if (!(await collectionExists(db, spec.name))) {
      try {
        await db.createCollection(spec.name)
      } catch (err) {
        if (mongoCode(err) !== 48) throw err
      }
    }
    const collection = db.collection(spec.name)
    for (const index of spec.indexes) {
      await collection.createIndex(index.key, {
        name: index.name,
        ...(index.unique === true ? { unique: true } : {}),
      })
    }
  }
}

export function mongoMigration(endpoint: MongoEndpoint): {
  journal: MigrationJournal
  steps: MigrationStep[]
  knownIds: string[]
} {
  let pinned: Db | null = null
  const db = (): Db => {
    if (!pinned) throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK')
    return pinned
  }

  const journal: MigrationJournal = {
    async lock() {
      // No session advisory lock, and DDL cannot share a transaction with the
      // journal insert. One pooled connection holds the unique lock document
      // for the DDL and the journal write, then drops it.
      const client = new MongoClient(endpoint.url, mongoClientOptions(endpoint, 1))
      let acquired = false
      try {
        await client.connect()
        const database = client.db()
        try {
          await database.collection<Row>(LOCK).insertOne({ _id: LOCK_ID, at: Date.now() })
          acquired = true
        } catch (err) {
          if (mongoCode(err) === 11000) {
            throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK')
          }
          throw err
        }
        pinned = database
      } catch (err) {
        try {
          await client.close()
        } catch {
          // The lock error is the one callers need.
        }
        pinned = null
        if (err instanceof BreadError && err.code === 'MIGRATION_LOCK') throw err
        throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, scrub(err))
      }
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        pinned = null
        try {
          if (acquired) await client.db().collection<Row>(LOCK).deleteOne({ _id: LOCK_ID })
        } catch (err) {
          throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {}, scrub(err))
        } finally {
          await client.close()
        }
      }
      return { commit: release, rollback: release }
    },

    async applied() {
      try {
        const database = db()
        if (!(await collectionExists(database, JOURNAL))) {
          throw new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING')
        }
        const rows = await database
          .collection<Row>(JOURNAL)
          .find({}, { projection: { checksum: 1 } })
          .sort({ _id: 1 })
          .toArray()
        return rows.map((row) => ({
          id: typeof row._id === 'string' ? row._id : '',
          checksum: typeof row.checksum === 'string' ? row.checksum : '',
        }))
      } catch (err) {
        throw journalError(err, 'Migration journal could not be read.')
      }
    },

    async ensure() {
      try {
        const database = db()
        if (!(await collectionExists(database, JOURNAL))) {
          try {
            await database.createCollection(JOURNAL)
          } catch (err) {
            if (mongoCode(err) !== 48) throw err
          }
        }
      } catch (err) {
        throw journalError(err, 'Migration journal could not be created.')
      }
    },

    async record(id, checksum) {
      if (typeof id !== 'string' || typeof checksum !== 'string') {
        throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID')
      }
      try {
        await db().collection<Row>(JOURNAL).insertOne({ _id: id, checksum, applied_at: Date.now() })
        return true
      } catch (err) {
        if (mongoCode(err) === 11000) return false
        throw journalError(err, 'Migration journal could not be written.')
      }
    },
  }

  const steps: MigrationStep[] = [
    {
      id: BASELINE_ID,
      checksum: BASELINE_CHECKSUM,
      up: () => applyBaseline(db()),
    },
  ]
  return { journal, steps, knownIds: [] }
}
