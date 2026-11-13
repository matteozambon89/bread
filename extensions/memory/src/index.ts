import type { AgentConfig, BreadPlugin } from '@breadai/core'
import type { MemoryBackend } from './backend.js'
import { combinedMemoryBackend, type CombinedMemoryBackend } from './combined-backend.js'
import type { MemoryModel } from './dream.js'
import { graphMemoryBackend, type GraphMemoryBackend } from './graph-backend.js'
import { storeMemoryBackend, type StoreMemoryBackend } from './store-backend.js'
import { createMemoryTools } from './tools.js'

export type { MemoryModel } from './dream.js'
export type { CombinedMemoryBackend } from './combined-backend.js'
export type { GraphMemoryBackend } from './graph-backend.js'
export type { StoreMemoryBackend } from './store-backend.js'

/** Agent opt-in under `cfg.plugins.memory`. `{}` enables the tools. `null` and `false` do not. */
export type MemoryAgentConfig = Record<string, never>

type MemoryPluginBackend = StoreMemoryBackend | GraphMemoryBackend | CombinedMemoryBackend

function openBackend(backend: MemoryPluginBackend): MemoryBackend {
  switch (backend.kind) {
    case 'store':
      return storeMemoryBackend(backend.store)
    case 'graph':
      // Graph-only dream reads the transcript from this store. Memory methods are not required.
      return graphMemoryBackend(backend.graph, backend.store)
    case 'combined':
      return combinedMemoryBackend(backend.store, backend.graph)
  }
}

export function memory(options: { backend: MemoryPluginBackend; model: MemoryModel }): BreadPlugin {
  const backend = openBackend(options.backend)
  const model = options.model
  return {
    name: 'memory',
    resolveAgentTools(_agentId, cfg: AgentConfig<unknown, unknown>) {
      const setting = cfg.plugins?.memory
      if (setting == null || setting === false) return []
      return createMemoryTools(backend, model)
    },
  }
}
