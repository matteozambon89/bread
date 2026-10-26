import { BreadError } from '../types.js'

// Fails closed: an empty or missing id would otherwise match every legacy row
// (they all backfilled to '') or, as a filter, every row in the store.
export function requireExecutionId(id: unknown, where: string): string {
  if (typeof id === 'string' && id.length > 0) return id
  throw new BreadError(
    `${where} needs a non-empty executionId, got ${id === '' ? "''" : String(id)}`,
    'INVALID_EXECUTION_ID',
    { where, executionId: id },
  )
}
