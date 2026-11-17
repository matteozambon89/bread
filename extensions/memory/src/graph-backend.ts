import { BreadError, type BreadStore, type Graph, type MemoryRecord } from '@breadai/core'
import { v7 as uuidv7 } from 'uuid'
import type { MemoryBackend, MemoryScope } from './backend.js'

const SEARCH_LIMIT = 10
const LIST_LIMIT = 100
const GRAPH_ROW_MESSAGE = 'Memory graph row is invalid.'
const GRAPH_OWNER_MESSAGE = 'Memory graph node belongs to another owner.'
const ROW_DROPPED = Symbol('dropped')

// MERGE is keyed by id only. ON CREATE SET does not touch an existing node.
// WHERE drops another owner's row so the caller gets no content back.
const CREATE_MEMORY = [
  'MERGE (m:BreadMemory {id: $id})',
  'ON CREATE SET m.content = $content, m.agentId = $agentId, m.principalIss = $iss, m.principalSub = $sub, m.createdAt = $createdAt',
  'WITH m',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
].join('\n')

const SEARCH_MEMORY = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND toLower(m.content) CONTAINS toLower($query)',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
  'ORDER BY m.createdAt DESC, m.id DESC',
  'LIMIT $limit',
].join('\n')

const LIST_MEMORY = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
  'ORDER BY m.createdAt DESC, m.id DESC',
  'LIMIT $limit',
].join('\n')

const READ_MEMORY = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND m.id = $id',
  'RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt',
].join('\n')

// Neo4j will not read a node deleted in the same query. Capture the id, or delete from a list.
const DELETE_MEMORY = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND m.id = $id',
  'WITH m, m.id AS memoryId',
  'DETACH DELETE m',
  'RETURN memoryId AS id',
].join('\n')

const DELETE_ORPHANS = [
  'MATCH (m:BreadMemory)',
  'WHERE m.agentId = $agentId AND m.principalIss = $iss AND m.principalSub = $sub AND NOT m.id IN $ids',
  'WITH collect(m) AS nodes',
  'FOREACH (node IN nodes | DETACH DELETE node)',
  'RETURN size(nodes) AS removed',
].join('\n')

export interface GraphMemoryBackend {
  kind: 'graph'
  graph: Graph
  store: BreadStore
}

function ownerParams(scope: MemoryScope): { agentId: string; iss: string; sub: string } {
  return {
    agentId: scope.agentId,
    iss: scope.principal.iss,
    sub: scope.principal.sub,
  }
}

function memoryRow(row: Record<string, unknown>): MemoryRecord {
  if (
    typeof row.id !== 'string' ||
    typeof row.content !== 'string' ||
    typeof row.createdAt !== 'number' ||
    !Number.isFinite(row.createdAt)
  ) {
    throw new BreadError(GRAPH_ROW_MESSAGE, 'MEMORY_GRAPH_ROW')
  }
  return { id: row.id, content: row.content, createdAt: row.createdAt }
}

function ownerError(scope: MemoryScope): BreadError {
  return new BreadError(GRAPH_OWNER_MESSAGE, 'MEMORY_GRAPH_OWNER', { agentId: scope.agentId })
}

export async function createMemoryNode(
  graph: Graph,
  record: MemoryRecord,
  scope: MemoryScope,
  signal?: AbortSignal,
): Promise<MemoryRecord> {
  const result = await graph.run(
    CREATE_MEMORY,
    {
      ...ownerParams(scope),
      id: record.id,
      content: record.content,
      createdAt: record.createdAt,
    },
    'write',
    signal,
  )
  const row = result.rows[0]
  if (row !== undefined) return memoryRow(row)
  // The write can commit before the driver drops a too-large RETURN row.
  if (result.truncated) return record
  throw ownerError(scope)
}

async function searchMemoryNodes(
  graph: Graph,
  scope: MemoryScope,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<MemoryRecord[]> {
  const result = await graph.run(
    SEARCH_MEMORY,
    { ...ownerParams(scope), query, limit },
    'read',
    signal,
  )
  return result.rows.map(memoryRow)
}

async function listMemoryNodes(
  graph: Graph,
  scope: MemoryScope,
  limit: number,
  signal?: AbortSignal,
): Promise<MemoryRecord[]> {
  const result = await graph.run(
    LIST_MEMORY,
    { ...ownerParams(scope), limit },
    'read',
    signal,
  )
  return result.rows.map(memoryRow)
}

async function readMemoryNode(
  graph: Graph,
  scope: MemoryScope,
  id: string,
  signal?: AbortSignal,
): Promise<MemoryRecord | typeof ROW_DROPPED | undefined> {
  const result = await graph.run(
    READ_MEMORY,
    { ...ownerParams(scope), id },
    'read',
    signal,
  )
  const row = result.rows[0]
  if (row !== undefined) return memoryRow(row)
  // Dropped for size after a match. The id is not missing, so do not create it again.
  if (result.truncated) return ROW_DROPPED
  return undefined
}

export async function deleteMemoryNode(
  graph: Graph,
  scope: MemoryScope,
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await graph.run(
    DELETE_MEMORY,
    { ...ownerParams(scope), id },
    'write',
    signal,
  )
  if (result.rows.length === 0) return false
  for (const row of result.rows) {
    if (typeof row.id !== 'string') throw new BreadError(GRAPH_ROW_MESSAGE, 'MEMORY_GRAPH_ROW')
  }
  return true
}

export async function linkMissingPage(
  graph: Graph,
  rows: MemoryRecord[],
  scope: MemoryScope,
  signal?: AbortSignal,
): Promise<void> {
  for (const row of rows) {
    const existing = await readMemoryNode(graph, scope, row.id, signal)
    if (existing !== undefined) continue
    await createMemoryNode(graph, row, scope, signal)
  }
}

export async function deleteOrphanMemories(
  graph: Graph,
  scope: MemoryScope,
  keepIds: string[],
  signal?: AbortSignal,
): Promise<void> {
  await graph.run(
    DELETE_ORPHANS,
    { ...ownerParams(scope), ids: keepIds },
    'write',
    signal,
  )
}

export function graphMemoryBackend(graph: Graph, store: BreadStore): MemoryBackend {
  return {
    addMemory(input) {
      const record = { id: uuidv7(), content: input.content, createdAt: Date.now() }
      return createMemoryNode(graph, record, input, input.signal)
    },
    searchMemories(input) {
      return searchMemoryNodes(graph, input, input.query, input.limit ?? SEARCH_LIMIT, input.signal)
    },
    listMemories(input) {
      return listMemoryNodes(graph, input, input.limit ?? LIST_LIMIT, input.signal)
    },
    async forgetMemory(input) {
      const deleted = await deleteMemoryNode(graph, input, input.id, input.signal)
      return { deleted }
    },
    getMessages(sessionId) {
      return store.getMessages(sessionId)
    },
  }
}
