import type { CrumbLogEntry } from '@breadai/core'

// No persisted task registry — status is always derived fresh from the
// run's own crumb log, the way transport-http-sse's passive stream route
// already derives "is this run done" for its catch-up replay.
export type TaskStatus = 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'not-found'

export function deriveTaskStatus(entries: CrumbLogEntry[]): TaskStatus {
  if (entries.length === 0) return 'not-found'
  let status: TaskStatus = 'working'
  for (const entry of entries) {
    if (entry.type === 'human:required') status = 'input-required'
    else if (entry.type === 'human:resumed') status = 'working'
    else if (entry.type === 'agent:run:end') status = 'completed'
    else if (entry.type === 'agent:error') {
      // `entry.crumb` is the wire-flattened form (toWireCrumb), so
      // `error.code` is a plain string here, not a live BreadError.
      const code = (entry.crumb as { error?: { code?: string } }).error?.code
      status = code === 'RUN_CANCELLED' ? 'canceled' : 'failed'
    }
  }
  return status
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled'
}

export function extractTaskId(params: unknown): string | undefined {
  const id = (params as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
}
