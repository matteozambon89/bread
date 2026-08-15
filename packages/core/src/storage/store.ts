import type {
  CheckpointParent,
  CleanupOptions,
  LoopStatus,
  Session,
  SessionMessage,
  TaskRunStatus,
  TaskUsage,
} from '../types.js'

// The single storage abstraction. A backend implements this one flat interface;
// the framework never wires per-domain adapters. Sessions and checkpoints are
// required (the runner always needs them); knowledge-graph and document methods
// are optional framework features a store may omit.
//
// Concrete implementations live in their own packages (@breadai/store-postgres,
// @breadai/store-sqlite, @breadai/store-memory). Postgres is the recommended
// backend, but nothing is wired implicitly — `config.store` must always be set
// explicitly (unset throws STORE_NOT_CONFIGURED).

export interface CheckpointRecord {
  id: string
  agentId: string
  runId: string
  sessionId: string
  toolName: string
  // The model's tool-call id for the pending human tool. Resume appends a
  // tool-result message keyed to it, so the replayed run continues from exactly
  // where it suspended.
  toolCallId: string
  schema: unknown
  prompt?: string | undefined
  // The skill active on the run that suspended, if any (RunOptions.skill).
  // Restored on resume so the tool set and system-prompt contribution match
  // what suspended, instead of silently dropping the skill.
  skill?: string | undefined
  // Composition continuation: set when the suspended run was a step inside a
  // pipeline or a supervisor delegation. Resume runs the rest of the
  // composition after the sub-run completes. See CheckpointParent.
  parent?: CheckpointParent | undefined
  // Set only on a supervisor checkpoint chain-suspended by delegations: the
  // delegate tool calls whose child runs are suspended. Entries resolve (and
  // are removed) as each child's resume completes; the last one continues the
  // supervisor run. Such a checkpoint is not directly resumable — resume the
  // child checkpoints instead.
  pending?: PendingDelegation[] | undefined
  createdAt: number
}

export interface PendingDelegation {
  toolCallId: string
  // The child's checkpoint id at suspension time — informational; a child that
  // re-suspends during its own resume gets a fresh checkpoint id, so entries
  // are keyed and resolved by toolCallId.
  childCheckpointId: string
  subAgentId: string
}

// A persisted agent-driven loop run. The host agent composes `pipeline` (a
// sequential list of agent ids, all members of `pool`) and re-runs it once per
// iteration until satisfied or `maxIterations` is reached.
export interface LoopRecord {
  id: string
  agentId: string
  sessionId: string
  runId: string
  pool: string[]
  pipeline: string[]
  maxIterations: number
  status: LoopStatus
  iterations: number // count of completed iterations
  result?: unknown
  startedAt: number
  completedAt?: number | undefined
}

// One execution of a loop's pipeline.
export interface LoopIteration {
  id: string
  loopId: string
  index: number // 1-based iteration number
  input: unknown
  output: unknown
  startedAt: number
  completedAt: number
}

export interface LoopFilter {
  sessionId?: string
  agentId?: string
  status?: LoopStatus
}

// One audited run of a one-shot task (see `runTask`). `agentId`/`sessionId`/`runId`
// are present when the task ran inside an agent run, absent for standalone calls.
export interface TaskRunRecord {
  id: string
  taskId: string
  agentId?: string | undefined
  sessionId?: string | undefined
  runId?: string | undefined
  model: { provider: string; model: string }
  input: unknown
  output?: unknown
  status: TaskRunStatus
  usage?: TaskUsage | undefined
  error?: string | undefined
  durationMs?: number | undefined
  createdAt: number
  completedAt?: number | undefined
}

export interface TaskRunFilter {
  taskId?: string
  agentId?: string
  sessionId?: string
  status?: TaskRunStatus
  limit?: number
}

// One durable crumb-log row. `seq` is the per-run monotonic position assigned
// by the instance choke point; `crumb` is the wire-safe JSON crumb (aggregated
// `text:delta` entries carry the joined delta). `sessionId` anchors cleanup —
// rows cascade when their session is deleted; `pipeline:step:*` crumbs are
// never logged (no session anchor).
export interface CrumbLogEntry {
  runId: string
  seq: number
  sessionId?: string | undefined
  agentId?: string | undefined
  type: string
  crumb: unknown
  createdAt: number
}

export interface KnowledgeNode {
  id: string
  label: string
  data: Record<string, unknown>
}

export interface DocumentRecord {
  id: string
  title: string
  source?: string | null
}

export interface BreadStore {
  // --- Sessions --------------------------------------------------------------
  createSession(opts?: { id?: string; tags?: Record<string, string> }): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(filter?: { tags?: Record<string, string> }): Promise<Session[]>
  deleteSession(id: string): Promise<void>
  cleanupSessions(opts?: CleanupOptions): Promise<number>
  getMessages(sessionId: string): Promise<SessionMessage[]>
  addMessage(
    sessionId: string,
    message: Omit<SessionMessage, 'id' | 'sessionId'>,
  ): Promise<void>

  // --- Checkpoints (HITL) ----------------------------------------------------
  saveCheckpoint(record: CheckpointRecord): Promise<void>
  getCheckpoint(id: string): Promise<CheckpointRecord | undefined>
  // Atomically deletes and returns the record, or undefined if it was already
  // gone — the claim primitive resume() uses so a concurrent second resume of
  // the same checkpoint loses the race instead of double-acting.
  deleteCheckpoint(id: string): Promise<CheckpointRecord | undefined>
  listCheckpoints(): Promise<CheckpointRecord[]>
  // Persists a suspending run's response messages and its checkpoint as one
  // atomic unit, so a crash between the two can never leave a dangling
  // tool-call message with no checkpoint to resume it.
  suspendRun(
    sessionId: string,
    messages: Omit<SessionMessage, 'id' | 'sessionId'>[],
    checkpoint: CheckpointRecord,
  ): Promise<void>

  // --- Loops (agent-driven) --------------------------------------------------
  createLoop(record: LoopRecord): Promise<void>
  updateLoop(
    id: string,
    patch: Partial<Pick<LoopRecord, 'status' | 'iterations' | 'result' | 'completedAt'>>,
  ): Promise<void>
  addLoopIteration(iteration: LoopIteration): Promise<void>
  getLoop(id: string): Promise<{ loop: LoopRecord; iterations: LoopIteration[] } | undefined>
  listLoops(filter?: LoopFilter): Promise<LoopRecord[]>

  // --- Task runs (audit; optional) ------------------------------------------
  createTaskRun?(record: TaskRunRecord): Promise<void>
  finishTaskRun?(
    id: string,
    patch: Partial<
      Pick<TaskRunRecord, 'status' | 'output' | 'usage' | 'error' | 'durationMs' | 'completedAt'>
    >,
  ): Promise<void>
  getTaskRun?(id: string): Promise<TaskRunRecord | undefined>
  listTaskRuns?(filter?: TaskRunFilter): Promise<TaskRunRecord[]>

  // --- Crumb run-log (replay/catch-up; optional) ------------------------------
  // Append-only per-run crumb history written by the instance choke point.
  // Powers Last-Event-ID catch-up on passive run streams; entries are deleted
  // via the session cascade (deleteSession/cleanupSessions).
  appendCrumbs?(entries: CrumbLogEntry[]): Promise<void>
  getCrumbs?(
    runId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<CrumbLogEntry[]>
  // Highest seq recorded for the run, 0 when the run has no entries. Seeds the
  // choke point's counter so resumed runs extend the original run's log.
  getMaxCrumbSeq?(runId: string): Promise<number>

  // --- Knowledge graph (optional) -------------------------------------------
  addKnowledgeNode?(input: {
    agentId: string
    sessionId: string
    label: string
    data?: Record<string, unknown>
  }): Promise<{ id: string; label: string }>
  addKnowledgeEdge?(input: { fromId: string; toId: string; relation: string }): Promise<void>
  queryKnowledge?(input: { agentId: string; query: string; limit?: number }): Promise<KnowledgeNode[]>
  forgetKnowledge?(input: { id: string }): Promise<{ deleted: boolean }>
  // Recent nodes for a session, used to build the auto-injected prompt context.
  knowledgeContext?(input: { agentId: string; sessionId: string; limit?: number }): Promise<
    Array<{ label: string; data: Record<string, unknown> }>
  >

  // --- Documents (optional) --------------------------------------------------
  ingestDocument?(input: {
    agentId: string
    title: string
    content: string
    source?: string | undefined
  }): Promise<{ id: string; title: string }>
  searchDocuments?(input: { agentId: string; query: string; limit?: number }): Promise<
    DocumentRecord[]
  >
  readDocument?(input: {
    agentId: string
    id: string
  }): Promise<{ title: string; content: string } | undefined>

  // --- Lifecycle -------------------------------------------------------------
  // Create schema / run migrations. Called once at startup if present.
  migrate?(): Promise<void>
  close?(): Promise<void>
}
