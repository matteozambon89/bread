import type { AgentConfig, BreadPlugin } from '@breadai/core'
import type { MemoryModel } from './dream.js'
import { requireMemory, type StoreMemoryBackend } from './store-backend.js'
import { createMemoryTools } from './tools.js'

export type { MemoryModel } from './dream.js'
export type { StoreMemoryBackend } from './store-backend.js'

/** Agent opt-in under `cfg.plugins.memory`. `{}` enables the tools. `null` and `false` do not. */
export type MemoryAgentConfig = Record<string, never>

export function memory(options: { backend: StoreMemoryBackend; model: MemoryModel }): BreadPlugin {
  const store = requireMemory(options.backend.store)
  const model = options.model
  return {
    name: 'memory',
    resolveAgentTools(_agentId, cfg: AgentConfig<unknown, unknown>) {
      const setting = cfg.plugins?.memory
      if (setting == null || setting === false) return []
      return createMemoryTools(store, model)
    },
  }
}
