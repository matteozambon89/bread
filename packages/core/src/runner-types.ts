import type { LoopRuntime } from './loop.js'
import type { SupervisorRuntime } from './supervisor.js'
import type { BlobStore } from './storage/blob-store.js'
import type { BreadStore } from './storage/store.js'
import type { TaskRegistry } from './task.js'
import type { ProviderRegistry } from './model-provider.js'
import type { ToolOrigin } from './permissions.js'
import type {
  AgentDefinition,
  BreadHooks,
  BreadPlugin,
  CredentialProvider,
  HumanRequiredHandler,
  HumanToolDefinition,
  RemoteAgent,
  ToolDefinition,
} from './types.js'

export type AgentRegistry = Map<string, AgentDefinition<unknown, unknown>>

// Crumbs are only yielded from here on out — the instance-level choke point
// (bread.ts `instrument`) is the single place they reach listeners and the bus,
// so the bus view always equals the client-visible stream.
export interface RunnerContext {
  store: BreadStore
  agents: AgentRegistry
  tasks?: TaskRegistry | undefined
  onHumanRequired?: HumanRequiredHandler | undefined
  systemPrompt?: string | undefined
  providers?: ProviderRegistry | undefined
  pluginTools?: { plugin: string; def: ToolDefinition }[] | undefined
  pluginToolResolvers?:
    | { plugin: string; resolve: NonNullable<BreadPlugin['resolveAgentTools']> }[]
    | undefined
  remoteAgents?: Record<string, RemoteAgent> | undefined
  credentials?: CredentialProvider | undefined
  blobStore?: BlobStore | undefined
  // Global hook chain tail: plugin-contributed hooks (config.plugins order),
  // then BreadConfig.hooks itself — always the last link in every scope's
  // beforeRun/afterRun/onError/onSuspend chain (see runner-helpers.ts's chain helpers).
  pluginHooks?: Partial<BreadHooks>[] | undefined
  hooks?: Partial<BreadHooks> | undefined
  signal?: AbortSignal | undefined
}

// One assembled tool plus the structured provenance the permissions module
// matches selectors against. Built fresh per run from every tool source
// (agent tools, plugins, built-ins, tasks, skills, MCP, loop control tools).
export interface ExecutableEntry {
  origin: ToolOrigin
  def: ToolDefinition
}

export interface AssembledTools {
  system: string | undefined
  executables: Map<string, ExecutableEntry>
  humanLeaves: Map<string, HumanToolDefinition<any>>
  gated: Set<string>
  loopRuntime: LoopRuntime | null
  supervisorRuntime: SupervisorRuntime | null
}
