export interface McpToolAnnotations {
  readOnlyHint?: boolean | undefined
  destructiveHint?: boolean | undefined
}

// `destructiveHint` wins. A read-only hint is the only case that does not ask.
// Missing annotations ask: the hints are not a trust signal.
export function mcpToolNeedsAsk(annotations?: McpToolAnnotations | null): boolean {
  if (annotations?.destructiveHint === true) return true
  if (annotations?.readOnlyHint === true) return false
  return true
}
