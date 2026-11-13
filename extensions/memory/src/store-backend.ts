import { BreadError, type BreadStore } from '@breadai/core'

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
