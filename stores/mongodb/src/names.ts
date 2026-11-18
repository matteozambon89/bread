export const SESSIONS = 'bread_sessions'
export const MESSAGES = 'bread_session_messages'
export const CHECKPOINTS = 'bread_checkpoints'
export const LOOPS = 'bread_loops'
export const LOOP_ITERATIONS = 'bread_loop_iterations'
export const MEMORIES = 'bread_memories'
export const DOCUMENTS = 'bread_documents'
export const CRUMBS = 'bread_crumbs'
export const TASK_RUNS = 'bread_task_runs'
export const JOURNAL = 'bread_migrations'
export const LOCK = 'bread_migration_lock'
export const LOCK_ID = 'migration'

export const DATA_COLLECTIONS = [
  SESSIONS,
  MESSAGES,
  CHECKPOINTS,
  LOOPS,
  LOOP_ITERATIONS,
  MEMORIES,
  DOCUMENTS,
  CRUMBS,
  TASK_RUNS,
] as const

const DATA_NAMES = new Set<string>(DATA_COLLECTIONS)

export function isDataCollection(name: string): boolean {
  return DATA_NAMES.has(name)
}
