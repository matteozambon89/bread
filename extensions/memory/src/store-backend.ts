import { BreadError, type BreadStore } from '@breadai/core'
import type { MemoryBackend } from './backend.js'

const MEMORY_METHODS = ['addMemory', 'searchMemories', 'listMemories', 'forgetMemory'] as const

export type MemoryStore = BreadStore & Required<Pick<BreadStore, (typeof MEMORY_METHODS)[number]>>

export interface StoreMemoryBackend {
  kind: 'store'
  store: BreadStore
}

export function requireMemory(store: BreadStore): MemoryStore {
  const missing = MEMORY_METHODS.filter((name) => typeof store[name] !== 'function')
  if (missing.length > 0) {
    throw new BreadError(
      'The configured store does not implement memory.',
      'STORE_NO_MEMORY',
      { missing: [...missing] },
    )
  }
  return store as MemoryStore
}

export function storeMemoryBackend(store: BreadStore): MemoryBackend {
  const memory = requireMemory(store)
  return {
    addMemory(input) {
      return memory.addMemory({
        agentId: input.agentId,
        principal: input.principal,
        content: input.content,
      })
    },
    searchMemories(input) {
      return memory.searchMemories({
        agentId: input.agentId,
        principal: input.principal,
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      })
    },
    listMemories(input) {
      return memory.listMemories({
        agentId: input.agentId,
        principal: input.principal,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      })
    },
    forgetMemory(input) {
      return memory.forgetMemory({
        agentId: input.agentId,
        principal: input.principal,
        id: input.id,
      })
    },
    getMessages(sessionId) {
      return memory.getMessages(sessionId)
    },
  }
}
