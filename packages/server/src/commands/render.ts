import type { ToolCallCrumb } from '@bread/core'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`
}

// One-line trace for a tool call, e.g. ↳ search({"q":"x"})
export function formatToolCall(crumb: ToolCallCrumb): string {
  const args = typeof crumb.args === 'string' ? crumb.args : JSON.stringify(crumb.args)
  return dim(`↳ ${crumb.toolName}(${args})`)
}

// Parse a human-tool response typed at the terminal: JSON when it parses,
// otherwise the raw string so plain answers like `yes` just work.
export function parseHumanResponse(line: string): unknown {
  const trimmed = line.trim()
  if (!trimmed) return trimmed
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}
