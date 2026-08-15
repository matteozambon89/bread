import type { BreadCrumb } from '@breadai/core'
import { BREAD_PROTOCOL_VERSION, encodeFrame } from '@breadai/core'

// One NDJSON line: a Bread protocol CrumbFrame, newline-terminated. Shared by
// every mount() route that streams crumbs.
export function crumbFrameLine(runId: string, seq: number, crumb: BreadCrumb): string {
  return `${encodeFrame({ v: BREAD_PROTOCOL_VERSION, type: 'crumb', runId, seq, crumb })}\n`
}
