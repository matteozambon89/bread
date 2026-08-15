// Runtime factory
export { createBread } from './bread.js'

// Transport — the crumb fabric between replicas (config.transport / bread.transport).
export type { BreadTransport, TransportCapability, BusFrame, Unsubscribe } from './transport.js'
export { streamTransport, toWireCrumb, fromWireCrumb } from './transport.js'

// The Bread protocol — the wire envelope duplex transports speak (frame shape,
// seq semantics, the catch-up handshake). No concrete transport speaks it yet.
export type { BreadProtocolFrame, CrumbFrame, SubscribeFrame } from './protocol.js'
export { BREAD_PROTOCOL_VERSION, encodeFrame, decodeFrame } from './protocol.js'

// Storage — the single BreadStore interface, implemented by store packages
// (@bread/store-postgres, @bread/store-sqlite, @bread/store-memory).
export type {
  BreadStore,
  CheckpointRecord,
  PendingDelegation,
  CrumbLogEntry,
  KnowledgeNode,
  DocumentRecord,
  LoopRecord,
  LoopIteration,
  LoopFilter,
  TaskRunRecord,
  TaskRunFilter,
} from './storage/store.js'

// Blob storage — a separate, optional seam for binary content (config.blobStore),
// implemented by e.g. @bread/store-s3. FileOutput/isFileOutput are the agent-output-side
// convention for handing back a reference to a stored/generated file.
export type { BlobStore, FileOutput } from './storage/blob-store.js'
export { isFileOutput } from './storage/blob-store.js'

// Internals used by the CLI loader and tests. @internal — not semver-stable;
// external callers should stay on the BreadInstance surface (run/resume/
// runPipeline/runTask + the registry getters).
export type { AgentRegistry, RunnerContext } from './runner.js'
export { resolveModel } from './model-provider.js'
export type { ModelRef, ProviderRegistry } from './model-provider.js'
export { buildToolCredentials } from './runner.js'
export type { Skill, SkillMeta, SkillToolEntry } from './skills.js'
export { injectSkillPrompt, loadSkill, loadSkillMeta } from './skills.js'
export { runPipeline } from './pipeline.js'
export { buildSupervisorTools, supervisorSummary } from './supervisor.js'
export { createKgTools, buildKgContext } from './kg.js'
export { createDocTools } from './documents.js'
export { createTaskTool } from './task.js'
export type { TaskRegistry, TaskToolDeps } from './task.js'
export { withRetry } from './retry.js'
export type { EvalResult, EvalSuiteResult } from './evals.js'
export { runEvals } from './evals.js'

// Define helpers
export {
  defineAgent,
  defineConfig,
  defineEval,
  defineHumanTool,
  defineTask,
  defineTool,
} from './define.js'

// Credential providers
export { envProvider, vaultProvider } from './credentials.js'

// Tool scopes, naming & permission resolution
export type { ToolScope, ToolOrigin, ParsedSelector, ToolPermissions, ResolvedPermissions } from './permissions.js'
export {
  TOOL_SCOPES,
  assertName,
  leafName,
  permId,
  parseSelector,
  matchesSelector,
  resolvePermissions,
  NAME_RE,
} from './permissions.js'

// Types
export type {
  AfterRunResult,
  AgentConfig,
  AgentDefinition,
  AgentErrorCrumb,
  AgentHooks,
  AgentRunEndCrumb,
  AgentRunStartCrumb,
  BeforeRunResult,
  BreadConfig,
  BreadCrumb,
  BreadHooks,
  BreadInstance,
  BreadInstanceRef,
  CleanupOptions,
  CredentialProvider,
  CustomFormat,
  DocumentConfig,
  ErrorHandlingConfig,
  EvalCase,
  EvalConfig,
  EvalDefinition,
  EvalScorer,
  EvalType,
  FileGeneratedCrumb,
  GlobalHookContext,
  HumanRequiredCrumb,
  HumanRequiredEvent,
  HumanRequiredHandler,
  HumanResumedCrumb,
  HumanToolDefinition,
  KnowledgeConfig,
  LoopConfig,
  LoopHooks,
  LoopStatus,
  LoopStartCrumb,
  LoopIterationStartCrumb,
  LoopIterationEndCrumb,
  LoopEndCrumb,
  CheckpointParent,
  OnErrorResult,
  OutputFormat,
  OutputMode,
  PipelineCheckpointParent,
  PipelineStep,
  SupervisorCheckpointParent,
  PipelineStepEndCrumb,
  PipelineStepStartCrumb,
  RemoteAgent,
  RetryConfig,
  RunContext,
  RunHooks,
  RunOptions,
  RunResult,
  Session,
  SessionManager,
  SessionMessage,
  AuthIdentity,
  BreadAuthStrategy,
  BreadSigner,
  BreadPlugin,
  PluginContext,
  SubAgentConfig,
  SupervisorConfig,
  SubAgentVisibility,
  SubagentRunEndCrumb,
  SubagentRunStartCrumb,
  TaskConfig,
  TaskDefinition,
  TaskHooks,
  TaskRunContext,
  TaskRunStatus,
  TaskUsage,
  TaskStartCrumb,
  TaskEndCrumb,
  TextDeltaCrumb,
  ToolCallCrumb,
  ToolConfig,
  ToolContext,
  ToolDefinition,
  ToolErrorCrumb,
  ToolHooks,
  ToolInputDeltaCrumb,
  ToolInputEndCrumb,
  ToolInputStartCrumb,
  ToolResultCrumb,
  ToolResultPartialCrumb,
  ToolRunContext,
  VaultOpts,
} from './types.js'

export { BreadError } from './types.js'
