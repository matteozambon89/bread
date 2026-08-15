import type { z } from 'zod'
import type { ModelRef, ProviderRegistry } from './model-provider.js'
import type { BlobStore, FileOutput } from './storage/blob-store.js'
import type { BreadStore } from './storage/store.js'
import type { BreadTransport } from './transport.js'

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface CredentialProvider {
  get(name: string): Promise<string | undefined>
}

export interface VaultOpts {
  address: string
  token: string
  mount?: string
}

// ---------------------------------------------------------------------------
// BreadCrumb — the typed stream atom
// ---------------------------------------------------------------------------

interface BaseCrumb {
  agentId: string
  runId: string
  sessionId: string
  timestamp: number
  // Per-run monotonic position in the durable crumb log, assigned by the
  // instance as the crumb leaves a public stream (never by emitters). For
  // `text:delta` crumbs it is a watermark — the seq of the last durable entry
  // — since deltas are aggregated before persisting. Absent on crumbs consumed
  // below the instance level (e.g. direct runAgent calls in tests).
  seq?: number | undefined
}

export interface AgentRunStartCrumb extends BaseCrumb {
  type: 'agent:run:start'
  input: unknown
  skill?: string | undefined
}

export interface AgentRunEndCrumb extends BaseCrumb {
  type: 'agent:run:end'
  output: unknown
  durationMs: number
  // Files the model generated directly during this run (no tool call involved) —
  // accumulated from every FileGeneratedCrumb emitted while the run was in progress.
  // Omitted, not [], when none were generated.
  files?: FileOutput[]
}

export interface TextDeltaCrumb extends BaseCrumb {
  type: 'text:delta'
  delta: string
}

// A reasoning-model's thinking output, streamed the same way as text:delta —
// separate crumb type since it's a distinct content channel from the final
// answer, not because the shape differs.
export interface ReasoningDeltaCrumb extends BaseCrumb {
  type: 'reasoning:delta'
  delta: string
}

// A file the model generated directly as part of its own generation (e.g. an
// image-generation-capable model) — sourced from the AI SDK's fullStream 'file'
// part, independent of any tool call. Emitted the instant the file is stored via
// BlobStore.put(); see AgentRunEndCrumb.files for the run's full accumulated list.
export interface FileGeneratedCrumb extends BaseCrumb {
  type: 'file:generated'
  uri: string
  mimeType: string
  name?: string
}

export interface ToolCallCrumb extends BaseCrumb {
  type: 'tool:call'
  toolCallId: string
  toolName: string
  args: unknown
}

export interface ToolResultCrumb extends BaseCrumb {
  type: 'tool:result'
  toolCallId: string
  toolName: string
  result: unknown
  durationMs: number
}

// A yielded intermediate value from a streaming tool's execute (an
// AsyncIterable<R> return instead of a single Promise<R>) — one crumb per
// yield, sourced entirely from bread's own drain of the iterable (see
// executeStreamingToolWithHooks in runner.ts), not from the AI SDK's
// fullStream 'tool-result'/preliminary parts — same single-source-of-truth
// rule as tool:call/tool:result. No durationMs: not final, no meaningful
// duration yet.
export interface ToolResultPartialCrumb extends BaseCrumb {
  type: 'tool:result:partial'
  toolCallId: string
  toolName: string
  result: unknown
}

// Emitted when a tool's execute throws and no onError hook recovers it. The AI
// SDK's own `tool-error` stream part isn't otherwise surfaced by the runner's
// fullStream consumer, so this is the only crumb-level signal a passive
// observer (no hooks configured) gets for a failed tool call.
export interface ToolErrorCrumb extends BaseCrumb {
  type: 'tool:error'
  toolCallId: string
  toolName: string
  error: BreadError
  durationMs: number
}

// The tool-call arg-assembly lifecycle, streamed ahead of the existing
// tool:call crumb (which still carries the complete, parsed args once
// assembly finishes) — additive, sourced from the AI SDK's
// tool-input-start/-delta/-end fullStream parts. Named tool:input:* rather
// than tool:call:* so `tool:input:end` (assembly finished) can't be misread
// as "execution finished" (that's tool:result).
export interface ToolInputStartCrumb extends BaseCrumb {
  type: 'tool:input:start'
  toolCallId: string
  toolName: string
}

export interface ToolInputDeltaCrumb extends BaseCrumb {
  type: 'tool:input:delta'
  toolCallId: string
  delta: string
}

export interface ToolInputEndCrumb extends BaseCrumb {
  type: 'tool:input:end'
  toolCallId: string
}

export interface HumanRequiredCrumb extends BaseCrumb {
  type: 'human:required'
  checkpointId: string
  toolName: string
  schema: unknown
  prompt?: string | undefined
  // 'input' = a human tool awaiting a response; 'approval' = an ask-gated tool
  // awaiting approve/reject. Ephemeral — not persisted on the checkpoint record.
  kind: 'input' | 'approval'
}

export interface HumanResumedCrumb extends BaseCrumb {
  type: 'human:resumed'
  checkpointId: string
  response: unknown
  kind: 'input' | 'approval'
}

export interface SubagentRunStartCrumb extends BaseCrumb {
  type: 'subagent:run:start'
  parentAgentId: string
  subagentId: string
}

export interface SubagentRunEndCrumb extends BaseCrumb {
  type: 'subagent:run:end'
  parentAgentId: string
  subagentId: string
  output: unknown
}

export interface PipelineStepStartCrumb {
  type: 'pipeline:step:start'
  pipelineId: string
  stepIndex: number
  agentId: string
  runId: string
  timestamp: number
  seq?: number | undefined
}

export interface PipelineStepEndCrumb {
  type: 'pipeline:step:end'
  pipelineId: string
  stepIndex: number
  agentId: string
  runId: string
  output: unknown
  timestamp: number
  seq?: number | undefined
}

export interface AgentErrorCrumb {
  type: 'agent:error'
  agentId: string
  runId?: string
  sessionId?: string
  error: BreadError
  timestamp: number
  seq?: number | undefined
}

// Agent-driven loops: the host agent composes a sequential pipeline from a
// configured pool, runs it, judges the output, and re-iterates the same
// pipeline until satisfied or `maxIterations` is reached.

export type LoopStatus = 'running' | 'completed' | 'exhausted' | 'failed'

export interface LoopStartCrumb extends BaseCrumb {
  type: 'loop:start'
  loopId: string
  pipeline: string[]
  maxIterations: number
}

export interface LoopIterationStartCrumb extends BaseCrumb {
  type: 'loop:iteration:start'
  loopId: string
  iteration: number
}

export interface LoopIterationEndCrumb extends BaseCrumb {
  type: 'loop:iteration:end'
  loopId: string
  iteration: number
  output: unknown
}

export interface LoopEndCrumb extends BaseCrumb {
  type: 'loop:end'
  loopId: string
  status: Exclude<LoopStatus, 'running'>
  iterations: number
  result?: unknown
}

// One-shot tasks: a stateless `generateObject` invocation run via `runTask`.
// Crumbs are emitted only when a task runs inside an agent run (it carries the
// parent's agentId/runId/sessionId for correlation); standalone calls are silent.

export type TaskRunStatus = 'running' | 'completed' | 'failed'

export interface TaskUsage {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
}

export interface TaskStartCrumb extends BaseCrumb {
  type: 'task:start'
  taskRunId: string
  taskId: string
  model: { provider: string; model: string }
}

export interface TaskEndCrumb extends BaseCrumb {
  type: 'task:end'
  taskRunId: string
  taskId: string
  status: Exclude<TaskRunStatus, 'running'>
  durationMs: number
  usage?: TaskUsage | undefined
  error?: string | undefined
}

export type BreadCrumb =
  | AgentRunStartCrumb
  | AgentRunEndCrumb
  | TextDeltaCrumb
  | ReasoningDeltaCrumb
  | FileGeneratedCrumb
  | ToolCallCrumb
  | ToolResultCrumb
  | ToolResultPartialCrumb
  | ToolErrorCrumb
  | ToolInputStartCrumb
  | ToolInputDeltaCrumb
  | ToolInputEndCrumb
  | HumanRequiredCrumb
  | HumanResumedCrumb
  | SubagentRunStartCrumb
  | SubagentRunEndCrumb
  | PipelineStepStartCrumb
  | PipelineStepEndCrumb
  | LoopStartCrumb
  | LoopIterationStartCrumb
  | LoopIterationEndCrumb
  | LoopEndCrumb
  | TaskStartCrumb
  | TaskEndCrumb
  | AgentErrorCrumb

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BreadError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'BreadError'
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
//
// One generic shape (`RunHooks`) is specialized per scope (Bread/Agent/Task/Tool).
// `beforeRun` may override the input or short-circuit the run entirely; `afterRun`
// may replace the output; `onError` may recover with a replacement output, request
// a retry (bounded by `ErrorHandlingConfig.retry`), or force immediate failure with
// a replacement error. Every scope resolves its hook chain in the same order:
// scoped hook -> plugin-contributed hooks -> `BreadConfig.hooks` (global).

export interface RunContext {
  agentId: string
  runId: string
  sessionId: string
  skill?: string
}

export interface TaskRunContext {
  agentId: string
  runId: string
  sessionId: string
  taskName: string
  credentials: CredentialProvider
  // So a hook can do I/O (e.g. load a document, persist entities) — task hooks
  // are author-defined externally and have no other way to reach the store.
  store: BreadStore
}

export interface ToolRunContext {
  agentId: string
  runId: string
  sessionId: string
  toolName: string
  credentials: CredentialProvider
}

// The context BreadHooks (global) sees, since it fires for every scope alike.
export type GlobalHookContext =
  | ({ scope: 'agent' } & RunContext)
  | ({ scope: 'task' } & TaskRunContext)
  | ({ scope: 'tool' } & ToolRunContext)

export type BeforeRunResult<TInput, TOutput> =
  | { action: 'continue'; input: TInput }
  | { action: 'shortCircuit'; output: TOutput }

export type AfterRunResult<TOutput> = { output: TOutput } | void

export type OnErrorResult<TOutput> =
  | { action: 'recover'; output: TOutput }
  | { action: 'retry' }
  | { action: 'fail'; error: BreadError }
  | void

export interface RunHooks<TInput, TOutput, TCtx> {
  beforeRun(
    ctx: TCtx & { input: TInput },
  ): Promise<BeforeRunResult<TInput, TOutput> | void> | BeforeRunResult<TInput, TOutput> | void
  afterRun(
    ctx: TCtx & { input: TInput; output: TOutput; durationMs: number },
  ): Promise<AfterRunResult<TOutput>> | AfterRunResult<TOutput>
  onError(
    ctx: TCtx & { input: TInput; error: BreadError },
  ): Promise<OnErrorResult<TOutput>> | OnErrorResult<TOutput>
}

export interface AgentHooks extends RunHooks<unknown, unknown, RunContext> {
  onSuspend(ctx: RunContext & { toolName: string; checkpointId: string }): Promise<void> | void
}

export interface BreadHooks extends RunHooks<unknown, unknown, GlobalHookContext> {
  onSuspend(
    ctx: GlobalHookContext & { toolName: string; checkpointId: string },
  ): Promise<void> | void
}

export type TaskHooks<Args, Out> = RunHooks<Args, Out, TaskRunContext>

export type ToolHooks<A, R> = RunHooks<A, R, ToolRunContext>

export interface LoopHooks {
  onInit(ctx: { loopId: string; pipeline: string[]; maxIterations: number }): Promise<void> | void
  onIterationStart(ctx: { loopId: string; iteration: number; input: unknown }): Promise<void> | void
  onIterationEnd(
    ctx: { loopId: string; iteration: number; output: unknown },
  ): Promise<AfterRunResult<unknown>> | AfterRunResult<unknown>
  onError(
    ctx: { loopId: string; iteration: number; error: BreadError },
  ): Promise<OnErrorResult<unknown>> | OnErrorResult<unknown>
  onFinish(
    ctx: { loopId: string; status: LoopStatus; iterations: number },
  ): Promise<void> | void
}

// ---------------------------------------------------------------------------
// HITL
// ---------------------------------------------------------------------------

export interface HumanRequiredEvent {
  agentId: string
  runId: string
  sessionId: string
  checkpointId: string
  toolName: string
  schema: unknown
  prompt?: string
  kind: 'input' | 'approval'
}

export type HumanRequiredHandler = (event: HumanRequiredEvent) => Promise<unknown> | unknown

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Session {
  id: string
  createdAt: number
  updatedAt: number
  tags: Record<string, string>
  agentId?: string
}

export interface SessionMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  content: unknown
  timestamp: number
}

export interface CleanupOptions {
  olderThanMs?: number | undefined
  tags?: Record<string, string> | undefined
}

export interface SessionManager {
  create(opts?: { id?: string; tags?: Record<string, string> }): Promise<Session>
  get(id: string): Promise<Session | undefined>
  list(filter?: { tags?: Record<string, string> }): Promise<Session[]>
  delete(id: string): Promise<void>
  cleanup(opts?: CleanupOptions): Promise<number>
  getMessages(sessionId: string): Promise<SessionMessage[]>
  addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'sessionId'>): Promise<void>
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface PluginContext {
  emit(crumb: BreadCrumb): void
  agentId: string
  runId: string
  sessionId: string
}

// An authenticated caller resolved by a BreadAuthStrategy.
export interface AuthIdentity {
  subject: string
  claims?: Record<string, unknown>
}

// A pluggable auth strategy: validates an incoming request, server side.
export interface BreadAuthStrategy {
  name: string
  authenticate(req: Request): Promise<AuthIdentity | null> | AuthIdentity | null
}

// A pluggable signer: attaches credentials to an outgoing request, client side.
export interface BreadSigner {
  name: string
  sign(headers: Headers): Promise<void> | void
}

// A BreadPlugin extends or integrates with bread. Beyond lifecycle hooks it can
// contribute pre-built agents, global tools, server `middleware`, and extra HTTP
// `routes`. (Storage is config-level via `BreadConfig.store`, model providers via
// `BreadConfig.providers`/`AgentConfig.providers` — neither is a plugin concern.
// Auth is not a special plugin concept either — an auth strategy attaches like any
// other middleware, e.g. via `@breadai/server`'s `authPlugin()`.)
export interface BreadPlugin {
  name: string
  init?(bread: BreadInstanceRef): Promise<void>
  close?(): Promise<void>
  // Merged into the global hook chain (scoped hook -> plugin hooks -> BreadConfig.hooks),
  // in `config.plugins` registration order, ahead of BreadConfig.hooks itself.
  hooks?: Partial<BreadHooks>
  agents?: Record<string, AgentDefinition<unknown, unknown>>
  tools?: ToolDefinition[]
  // Resolves additional tools for one specific agent, driven by that agent's
  // own `cfg.plugins?.<this-plugin-name>` config — opaque to core, which never
  // inspects what a plugin stores there or why. Called once per agent during
  // tool assembly (in addition to the static `tools` above), so a plugin can
  // do per-agent, config-driven things like connecting to servers a specific
  // agent named. Returned tools are tagged `plugin:<this-plugin-name>/<name>`,
  // same scope as the static `tools` above.
  resolveAgentTools?(
    agentId: string,
    cfg: AgentConfig<unknown, unknown>,
  ): Promise<ToolDefinition[]> | ToolDefinition[]
  // Register middleware on the server's Hono app — applied before any routes
  // (this plugin's own or another plugin's), so e.g. an auth gate can wrap
  // everything downstream regardless of registration order. Typed as `unknown`
  // for the same reason as `routes` below.
  middleware?: (app: unknown) => void
  // Register HTTP routes on the server's Hono app. Typed as `unknown` so core
  // stays free of a Hono dependency; the cli server passes the real `Hono`.
  routes?: (app: unknown) => void
}

// Forward reference so BreadPlugin doesn't create a circular dependency with BreadInstance
export interface BreadInstanceRef {
  on(event: 'crumb', handler: (crumb: BreadCrumb) => void): void
  on(event: 'human:required', handler: HumanRequiredHandler): void
  off(event: string, handler: (...args: unknown[]) => unknown): void
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolContext {
  agentId: string
  sessionId: string
  runId: string
  user?: unknown
  tenantId?: string
  credentials: CredentialProvider
  // Present when the host run was given a signal (RunOptions.signal) — a
  // signal-aware tool (e.g. a task tool's own model call) can observe it, but
  // bread cannot force a non-cooperative tool's execute() to stop.
  signal?: AbortSignal
  // Present when config.blobStore is set — store a generated/derived file and
  // echo the resulting uri as (part of) this tool's output.
  blobStore?: BlobStore
}

export interface ToolDefinition<A = unknown, R = unknown> {
  name: string
  description: string
  schema: z.ZodType<A>
  outputSchema?: z.ZodType<R>
  credentials?: string[]
  // Per-tool override of the credential resolver, distinct from `credentials`
  // above (which only *names* the secrets this tool needs). When set, this
  // provider is consulted instead of the `BreadConfig`-level default.
  credentialProvider?: CredentialProvider
  hooks?: Partial<ToolHooks<A, R>>
  // Bounds onError's `retry` action for this tool, same as AgentConfig/TaskConfig.
  errorHandling?: ErrorHandlingConfig
  // Mirrors the AI SDK's own `ToolExecuteFunction<INPUT, OUTPUT>`
  // (@ai-sdk/provider-utils/src/types/tool.ts) exactly: return an
  // AsyncIterable<R> to stream intermediate progress values as
  // `tool:result:partial` crumbs before the final `tool:result`. The last
  // *yielded* value is the tool's result — an async generator's `return`
  // value is never observed (a plain `for await...of` drain, used both here
  // and by the AI SDK itself, never surfaces it). No onError/retry support
  // for the streaming case — see runner.ts's executeStreamingToolWithHooks.
  execute(args: A, ctx: ToolContext): AsyncIterable<R> | PromiseLike<R> | R
}

export interface ToolConfig<A, R> {
  name: string
  description: string
  schema: z.ZodType<A>
  outputSchema?: z.ZodType<R>
  credentials?: string[]
  // See `ToolDefinition.credentialProvider` — identical field, since
  // `defineTool` passes `ToolConfig` straight through unchanged.
  credentialProvider?: CredentialProvider
  hooks?: Partial<ToolHooks<A, R>>
  errorHandling?: ErrorHandlingConfig
  execute(args: A, ctx: ToolContext): AsyncIterable<R> | PromiseLike<R> | R
}

// ---------------------------------------------------------------------------
// HITL tool
// ---------------------------------------------------------------------------

export interface HumanToolDefinition<S extends z.ZodType> {
  name: string
  schema: S
  _human: true
}

// ---------------------------------------------------------------------------
// Knowledge & Documents
// ---------------------------------------------------------------------------

export interface KnowledgeConfig {
  autoInject?: boolean
  maxTokens?: number
}

// Setting `documents` (an empty options bag today) auto-attaches the core_doc_*
// tools when the store implements the document methods. Options may appear here
// later; until then `documents: {}` is the whole configuration.
export interface DocumentConfig {}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export interface RetryConfig {
  attempts: number
  backoffMs?: number
  backoffMultiplier?: number
}

// `fallback` is retired — folded into `onError`'s `{ action: 'recover' }` result.
export interface ErrorHandlingConfig {
  retry?: RetryConfig
}

// ---------------------------------------------------------------------------
// Sub-agents (supervisor mode)
// ---------------------------------------------------------------------------

export type SubAgentVisibility = 'hidden' | 'mediate' | 'passthrough'

export interface SubAgentConfig {
  agentId: string
  visibility?: SubAgentVisibility
  max?: number // max concurrent delegations to this sub-agent
}

export interface SupervisorConfig {
  max?: number // max concurrent delegations overall
  agents: SubAgentConfig[]
}

// Agent-driven loop. The consumer supplies a pool of agents the host may compose
// into a sequential pipeline at runtime, and a hard cap on iterations (the cap is
// consumer-owned, never agent-chosen). When set, the runner injects the
// core_start_loop / core_iterate_loop / core_finish_loop tools.
export interface LoopConfig {
  pool: string[] // agent ids the host may compose into its pipeline
  maxIterations: number // hard cap enforced by the runner
  hooks?: Partial<LoopHooks>
  // Bounds onError's `retry` action per iteration, same as AgentConfig/TaskConfig/ToolConfig.
  errorHandling?: ErrorHandlingConfig
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

export type BuiltinFormat = 'text' | 'json' | 'markdown'

export interface CustomFormat<O> {
  name: string
  parse(raw: string): O
}

// 'text'/'markdown' stream raw model text with no further parsing — output is definitionally a
// string, so they're only valid when O extends string. 'json' drives structured generation via
// generateObject (any O). CustomFormat<O> is the one path from streamed text to a non-string O —
// e.g. a text-format agent that still needs tool access (unlike 'json', which never gets tools).
export type OutputFormat<O> = 'json' | CustomFormat<O> | (O extends string ? 'text' | 'markdown' : never)

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export interface AgentConfig<I, O> {
  model: ModelRef
  // Per-agent named provider instances, checked before the global
  // `BreadConfig.providers` on a name collision — e.g. pin this agent to a
  // different region or account without touching the global registry.
  providers?: ProviderRegistry
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  output: {
    format: OutputFormat<O>
  }
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] }
  steps?: { max?: number } // max tool-call steps per run (not concurrency)
  knowledge?: KnowledgeConfig
  documents?: DocumentConfig
  // Ids of one-shot tasks to expose to this agent as tools (resolved from the
  // task registry by the runner).
  tasks?: string[]
  // Opaque, per-plugin agent configuration, keyed by plugin name — e.g.
  // `{ mcp_client: { servers: [...] } }`. Core never inspects the contents;
  // a plugin reads its own key here inside `BreadPlugin.resolveAgentTools`.
  plugins?: Record<string, unknown>
  supervisor?: SupervisorConfig
  loop?: LoopConfig
  errorHandling?: ErrorHandlingConfig
  hooks?: Partial<AgentHooks>
}

export interface AgentDefinition<I, O> {
  config: AgentConfig<I, O>
  _agentDef: true
}

// ---------------------------------------------------------------------------
// Tasks (one-shot, stateless) — compile to LLM-callable tools
// ---------------------------------------------------------------------------

// A Task is a single structured LLM call — no tool loop, session, or HITL. It is
// defined once (a `tasks/<id>.ts` file) and compiled to an LLM-callable tool via
// `createTaskTool`; agents opt in by listing the task name in `config.tasks`.
// `beforeRun` supersedes the old `pre` (maps tool args -> model input, or
// short-circuits); `afterRun` supersedes `post` (maps/replaces the model's
// structured output before it becomes the tool result).
export interface TaskConfig<Args, Out> {
  name: string
  description: string
  model: ModelRef
  instructions: string
  schema: z.ZodType<Args>
  outputSchema: z.ZodType<Out>
  hooks?: Partial<TaskHooks<Args, Out>>
  // Bounds onError's `retry` action for this task, same as AgentConfig.errorHandling.
  errorHandling?: ErrorHandlingConfig
}

export interface TaskDefinition<Args, Out> {
  config: TaskConfig<Args, Out>
  _taskDef: true
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type PipelineStep =
  | { type: 'agent'; agentId: string; skill?: string }
  | { type: 'parallel'; steps: PipelineStep[] }
  | { type: 'map'; agentId: string }

// Continuation linkage persisted on a checkpoint created inside a composition.
// When a sub-run suspends for HITL mid-pipeline, resume must run the rest of
// the composition — not just the suspended agent. The record is self-contained
// (remaining steps are persisted, never re-resolved from config) because
// pipelines can be dynamically composed: loops run pipelines whose id is the
// loopId, which exists in no config.
export interface PipelineCheckpointParent {
  kind: 'pipeline'
  pipelineId: string
  // Index of the suspended step; the crumb/runId numbering of the continuation
  // picks up after it.
  stepIndex: number
  // getStepAgentId of the suspended step, for the step:end crumb on resume.
  stepAgentId: string
  remainingSteps: PipelineStep[]
  // Set when the suspended step is `map`: fan-out progress so resume finishes
  // the remaining items before moving on.
  map?: {
    agentId: string
    settledOutputs: unknown[]
    remainingItems: unknown[]
  }
  // Set when the suspension happened inside a `parallel` branch. Sibling data
  // is filled in after every branch settles; suspended siblings stay null in
  // settledOutputs until their own resume.
  parallel?: {
    branchIndex: number
    settledOutputs: (unknown | null)[]
    pendingCheckpointIds: string[]
  }
}

// Chain-suspension linkage for delegation: set on a delegated sub-run's
// checkpoint when its suspension also suspended the supervisor run awaiting
// it. Resuming the child to completion feeds its output back as the
// supervisor's pending core_delegate tool result (see the supervisor
// checkpoint's `pending` list) and, once no delegations remain pending,
// continues the supervisor run.
export interface SupervisorCheckpointParent {
  kind: 'supervisor'
  // The supervisor's own checkpoint awaiting this delegation.
  checkpointId: string
  // The core_delegate tool call this child's output resolves.
  toolCallId: string
}

export type CheckpointParent = PipelineCheckpointParent | SupervisorCheckpointParent

// ---------------------------------------------------------------------------
// Remote agents
// ---------------------------------------------------------------------------

// A registered remote agent: the object a transport's remoteAgent(opts) returns
// (e.g. `@breadai/transport-http-chunked`'s remoteAgent({ url, headers?, auth? })).
// `config.remoteAgents` holds these; the runner relays their crumb stream as if
// local. `init`/`close` bracket the instance lifecycle (bread.start/stop) for
// remote agents that hold connections (event-bus brokers, persistent sockets).
export interface RemoteAgent {
  run(agentId: string, input: unknown, opts?: RunOptions): AsyncIterable<BreadCrumb>
  init?(): Promise<void>
  close?(): Promise<void>
}

// ---------------------------------------------------------------------------
// BreadConfig
// ---------------------------------------------------------------------------

export interface BreadConfig {
  entrypoints: string[]
  pipelines?: Record<string, PipelineStep[]>
  // Instance-level in-flight cap, enforced identically by all four public entry
  // points — run/runPipeline/resume (streamed) and runTask (plain async) — each
  // throws CONCURRENCY_LIMIT at the cap. For streamed calls the check+increment
  // live inside the returned generator (right before its try), so an
  // un-iterated generator never holds a slot; the limit then surfaces on first
  // iteration rather than synchronously at call time. No queueing: callers at
  // the cap must retry, not block.
  concurrency?: { max: number }
  // The storage backend. Required in practice: unset throws
  // STORE_NOT_CONFIGURED from every entry point — there is no auto-wired or
  // interactive fallback. Optional here only so a partial config can be built
  // up before `bread.start()`/`createServer()` validate it.
  store?: BreadStore
  // Optional binary-content storage (e.g. @breadai/store-s3), consumed by
  // features that need to persist file bytes — currently A2A's inline
  // FilePart handling. Unlike `store`, unset is not an error; a feature that
  // needs it and finds it missing fails with its own clear, feature-specific
  // message instead of a startup-time throw.
  blobStore?: BlobStore
  // Named model-provider instances, keyed by the name `model.provider` refers
  // to (e.g. `{ anthropic, 'anthropic-eu': createAnthropic({ baseURL }) }`).
  // Core has no built-ins of its own — install @breadai/provider-catalog for the
  // common @ai-sdk/* set, or hand-write factories. An agent's own `providers`
  // (AgentConfig.providers) is checked first and wins on a name collision.
  providers?: ProviderRegistry
  // The crumb fabric between replicas of this app. Defaults to the embedded
  // Stream transport (single container); set a distributed implementation
  // (e.g. @breadai/transport-redis) so passive subscribers on other replicas
  // see live runs.
  transport?: BreadTransport
  plugins?: BreadPlugin[]
  errorHandling?: ErrorHandlingConfig
  hooks?: Partial<BreadHooks>
  remoteAgents?: Record<string, RemoteAgent>
  // idleTimeout: seconds of connection inactivity Bun.serve tolerates before
  // closing (Bun's own default is 10s). Long-lived streaming responses can go
  // quiet for longer than that between crumbs (e.g. a reasoning model's
  // thinking gap) — raise this (or set 0 to disable) if that's cutting a
  // stream short. Omit to keep Bun's default.
  // maxBodyBytes: request body size cap applied to every route via Hono's
  // `bodyLimit` (see `createServer`). Defaults to 1 MB; a caller over the
  // limit gets a 413. Rate limiting / concurrency protection is deliberately
  // not built in — front the server with a gateway/rate limiter if you need it.
  server?: { port?: number; host?: string; idleTimeout?: number; maxBodyBytes?: number }
  // Run-wide default credential resolver, consulted by any tool that doesn't
  // set its own `credentialProvider`. Omit it to keep today's behavior
  // (unscoped `process.env` access via the implicit `envProvider()` fallback).
  credentials?: CredentialProvider
  // Gates which crumbs reach `transport` (live publish and a passive stream's
  // catch-up replay alike) — return false to drop one. Persistence and local
  // `bread.on('crumb')` listeners are unaffected; this only governs what a
  // transport ever sees, regardless of which transport is configured (e.g.
  // to opt a client-facing HTTP transport out of `reasoning:delta` noise
  // while a durable audit log still has it).
  crumbFilter?: (crumb: BreadCrumb) => boolean
}

// ---------------------------------------------------------------------------
// RunOptions and RunResult
// ---------------------------------------------------------------------------

export type OutputMode = 'sync' | 'stream'

export interface RunOptions {
  skill?: string
  session?: { id?: string; tags?: Record<string, string> }
  onHumanRequired?: HumanRequiredHandler
  mode?: OutputMode
  // Aborting cancels the in-flight model call (and any tool that itself
  // observes the signal via ToolContext.signal) and stops a parallel
  // pipeline/supervisor fan-out from launching further branches. Surfaces as
  // an `agent:error` crumb with a `RUN_CANCELLED` BreadError — no new crumb
  // type. Bread cannot force a non-cooperative tool's execute() to stop.
  signal?: AbortSignal
  // @internal — composition continuation linkage, set by runPipeline (never by
  // callers). Persisted onto the checkpoint if this run suspends for HITL, so
  // resume can continue the surrounding pipeline, not just this agent.
  _parent?: CheckpointParent
}

// Shared by resume()/runPipeline(), which have no other RunOptions fields to
// take (no skill/mode/onHumanRequired equivalent) but still need a signal.
export interface CancellableOptions {
  signal?: AbortSignal
}

export type RunResult<Mode extends OutputMode = 'stream'> =
  Mode extends 'sync' ? Promise<{ output: unknown; files?: FileOutput[] }> : AsyncIterable<BreadCrumb>

// ---------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------

export type EvalScorer =
  | { type: 'exact'; expected: string }
  | { type: 'contains'; expected: string }
  | { type: 'regex'; pattern: string }
  | { type: 'llmJudge'; prompt: string; model?: string }
  | { type: 'custom'; fn: (output: unknown) => boolean | Promise<boolean> }

export interface EvalCase {
  name: string
  input: unknown
  skill?: string
  scorers: EvalScorer[]
}

export type EvalType = 'functional' | 'prompt-injection' | 'jailbreak' | 'data-exfiltration'

export interface EvalConfig {
  agentId: string
  type?: EvalType
  cases: EvalCase[]
}

export interface EvalDefinition {
  config: EvalConfig
  _evalDef: true
}

// ---------------------------------------------------------------------------
// BreadInstance
// ---------------------------------------------------------------------------

export interface BreadInstance extends BreadInstanceRef {
  run(agentId: string, input: unknown, opts?: RunOptions & { mode: 'sync' }): Promise<{ output: unknown; files?: FileOutput[] }>
  run(agentId: string, input: unknown, opts?: RunOptions & { mode?: 'stream' }): AsyncIterable<BreadCrumb>
  run(
    agentId: string,
    input: unknown,
    opts?: RunOptions,
  ): AsyncIterable<BreadCrumb> | Promise<{ output: unknown; files?: FileOutput[] }>

  // Resume a suspended HITL run by supplying the human's answer. Returns the
  // continuation crumb stream — the run is replayed from the store, so this
  // works after a restart or on a different process than the original run.
  resume(checkpointId: string, response: unknown, opts?: CancellableOptions): AsyncGenerator<BreadCrumb>

  // Run a pipeline declared in `config.pipelines` and stream its crumbs
  // (step framing + inner agent runs). Throws PIPELINE_NOT_FOUND for an
  // unknown id.
  runPipeline(pipelineId: string, input: unknown, opts?: CancellableOptions): AsyncIterable<BreadCrumb>

  // Run a registered one-shot task with full hook/audit treatment (beforeRun/
  // onError/afterRun chains, TaskRunRecord persistence). Standalone task runs
  // have no host run stream, so they emit no crumbs. `opts` sets the audit
  // attribution recorded on the TaskRunRecord (defaults: agentId 'standalone',
  // fresh ids). Throws TASK_NOT_FOUND for an unknown id.
  runTask(
    taskId: string,
    args: unknown,
    opts?: { agentId?: string; sessionId?: string; runId?: string },
  ): Promise<unknown>

  on(event: 'crumb', handler: (crumb: BreadCrumb) => void): void
  on(event: 'human:required', handler: HumanRequiredHandler): void
  off(event: string, handler: (...args: unknown[]) => unknown): void

  store: BreadStore
  // Optional binary-content storage (config.blobStore) — undefined when unset.
  blobStore: BlobStore | undefined
  // The live crumb fabric (config.transport, or the embedded Stream default).
  // Ingress packages subscribe here to tail a run executing on any replica.
  transport: BreadTransport

  // Live registries and config passthroughs an ingress needs to enumerate and
  // expose what this instance serves (agents/tasks include plugin-contributed
  // entries once start() has merged them).
  agents: ReadonlyMap<string, AgentDefinition<unknown, unknown>>
  tasks: ReadonlyMap<string, TaskDefinition<unknown, unknown>>
  // Global tools contributed by plugins, tagged with the contributing plugin.
  pluginTools: ReadonlyArray<{ plugin: string; def: ToolDefinition }>
  // The run-wide default credential resolver (config.credentials), if any.
  credentials: CredentialProvider | undefined
  // config.crumbFilter, if any — transports apply this themselves (e.g. a
  // passive stream's catch-up replay, which reads the store directly and so
  // bypasses the instance's own live-publish filtering).
  crumbFilter: ((crumb: BreadCrumb) => boolean) | undefined

  start(): Promise<void>
  stop(): Promise<void>
}
