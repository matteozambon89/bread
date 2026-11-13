import type { MemoryRecord, Principal, SessionMessage } from '@breadai/core'

export interface MemoryScope {
  agentId: string
  principal: Principal
}

export interface MemoryBackend {
  addMemory(input: MemoryScope & { content: string; signal?: AbortSignal }): Promise<MemoryRecord>
  searchMemories(
    input: MemoryScope & { query: string; limit?: number; signal?: AbortSignal },
  ): Promise<MemoryRecord[]>
  listMemories(input: MemoryScope & { limit?: number; signal?: AbortSignal }): Promise<MemoryRecord[]>
  forgetMemory(input: MemoryScope & { id: string; signal?: AbortSignal }): Promise<{ deleted: boolean }>
  getMessages(sessionId: string): Promise<SessionMessage[]>
  linkMissing?(rows: MemoryRecord[], scope: MemoryScope, signal?: AbortSignal): Promise<void>
}
