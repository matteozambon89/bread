import type { z } from 'zod'

export type GraphMode = 'read' | 'write'

export interface GraphResult {
  rows: Record<string, unknown>[]
  truncated: boolean
}

// `close` is lifecycle only, same idea as RemoteAgent.close. It is not a query API.
export interface Graph {
  run(
    statement: string,
    params: Record<string, unknown>,
    mode: GraphMode,
    signal?: AbortSignal,
  ): Promise<GraphResult>
  close?(): Promise<void>
}

export interface GraphQuery {
  description: string
  statement: string
  mode: GraphMode
  schema: z.ZodType
  // Writes require a tenant unless the query sets this false. A null tenant is
  // one shared scope, not every tenant. Reads do not default this on.
  requireTenant?: boolean
}
