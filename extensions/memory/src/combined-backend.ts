import type { BreadStore, Graph } from '@breadai/core'
import type { MemoryBackend } from './backend.js'
import {
  createMemoryNode,
  deleteMemoryNode,
  deleteOrphanMemories,
  linkMissingPage,
} from './graph-backend.js'
import { requireMemory } from './store-backend.js'

const ORPHAN_SCAN_LIMIT = 1000

export interface CombinedMemoryBackend {
  kind: 'combined'
  store: BreadStore
  graph: Graph
}

export function combinedMemoryBackend(store: BreadStore, graph: Graph): MemoryBackend {
  const memory = requireMemory(store)
  return {
    async addMemory(input) {
      const record = await memory.addMemory({
        agentId: input.agentId,
        principal: input.principal,
        content: input.content,
      })
      // The store row stays when this throws. There is no delete and no retry.
      await createMemoryNode(graph, record, input, input.signal)
      return record
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
    async forgetMemory(input) {
      // Graph delete first. A throw leaves the store row and is not reported as deleted.
      await deleteMemoryNode(graph, input, input.id, input.signal)
      return memory.forgetMemory({
        agentId: input.agentId,
        principal: input.principal,
        id: input.id,
      })
    },
    getMessages(sessionId) {
      return memory.getMessages(sessionId)
    },
    async linkMissing(rows, scope, signal) {
      // This page only. A failed graph write is repaired here; older rows wait for a later page.
      await linkMissingPage(graph, rows, scope, signal)
      const listed = await memory.listMemories({
        agentId: scope.agentId,
        principal: scope.principal,
        limit: ORPHAN_SCAN_LIMIT,
      })
      // Orphans are not on the dream page. Hitting the cap means the id list may be incomplete.
      if (listed.length >= ORPHAN_SCAN_LIMIT) return
      await deleteOrphanMemories(
        graph,
        scope,
        listed.map((row) => row.id),
        signal,
      )
    },
  }
}
