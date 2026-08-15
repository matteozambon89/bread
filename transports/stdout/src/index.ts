import { isFileOutput } from '@breadai/core'
import type { BreadTransport, BusFrame, ToolCallCrumb } from '@breadai/core'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function dim(text: string): string {
  return `${DIM}${text}${RESET}`
}

// Small, deliberate duplicate of packages/server/src/commands/render.ts's
// formatToolCall — a transports/* package must not depend on @breadai/server.
function formatToolCall(crumb: ToolCallCrumb): string {
  const args = typeof crumb.args === 'string' ? crumb.args : JSON.stringify(crumb.args)
  return dim(`↳ ${crumb.toolName}(${args})`)
}

export interface StdoutTransportOptions {
  // Also print tool:call lines. Off by default — a plain conversational view
  // of text:delta + errors only.
  trace?: boolean
}

// Renders a run's crumb stream to the terminal — the CLI's (bread chat/invoke)
// default renderer. Sink-only: nothing subscribes to a terminal, so there is
// no subscribe()/replay to implement.
export function transport(opts: StdoutTransportOptions = {}): BreadTransport {
  // Tracks, per run, whether the "agent ▸ " label has already been printed
  // for the current run of consecutive text:delta frames — reset whenever
  // something else breaks the line (a traced tool call, an error, a
  // human:required prompt, or the run ending).
  const labeled = new Set<string>()

  return {
    capability: 'sink',

    publish(frame: BusFrame): void {
      const { crumb } = frame
      switch (crumb.type) {
        case 'text:delta':
          if (!labeled.has(frame.runId)) {
            process.stdout.write('agent ▸ ')
            labeled.add(frame.runId)
          }
          process.stdout.write(crumb.delta)
          break
        case 'reasoning:delta':
          if (!labeled.has(frame.runId)) {
            process.stdout.write('agent ▸ ')
            labeled.add(frame.runId)
          }
          process.stdout.write(dim(crumb.delta))
          break
        case 'tool:call':
          if (opts.trace) {
            process.stdout.write(`\n${formatToolCall(crumb)}\n`)
            labeled.delete(frame.runId)
          }
          break
        case 'file:generated':
          process.stdout.write(`\n${dim(`↳ generated file: ${crumb.uri} (${crumb.mimeType})`)}\n`)
          labeled.delete(frame.runId)
          break
        case 'tool:error':
          process.stderr.write(`\n${dim(`↳ ${crumb.toolName} failed: ${crumb.error.message}`)}\n`)
          labeled.delete(frame.runId)
          break
        case 'agent:error':
          process.stderr.write(`\n${dim(`agent error: ${crumb.error.message}`)}\n`)
          labeled.delete(frame.runId)
          break
        case 'human:required':
          labeled.delete(frame.runId)
          break
        case 'agent:run:end':
          if (isFileOutput(crumb.output)) {
            process.stdout.write(`\n${dim(`↳ generated file: ${crumb.output.uri} (${crumb.output.mimeType ?? 'unknown'})`)}\n`)
          }
          labeled.delete(frame.runId)
          break
        default:
          break
      }
    },
  }
}
