import { describe, expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import type { BusFrame } from '@breadai/core'
import { transport } from '../src/index.js'

function frame(overrides: Partial<BusFrame> & Pick<BusFrame, 'crumb'>): BusFrame {
  return { runId: 'r1', seq: 1, ...overrides }
}

// Captures stdout/stderr writes for one test without leaking the patch past it.
function captureWrites(fn: () => void): { out: string; err: string } {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = ((chunk: string) => {
    out += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    err += chunk
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { out, err }
}

describe('@breadai/transport-stdout', () => {
  test('capability is sink — no subscribe', () => {
    expect(transport().capability).toBe('sink')
    expect(transport().subscribe).toBeUndefined()
  })

  test('labels the first text:delta of a run and streams the rest unlabeled', () => {
    const t = transport()
    const { out } = captureWrites(() => {
      t.publish(
        frame({ crumb: { type: 'text:delta', agentId: 'a', runId: 'r1', sessionId: 's', timestamp: 1, delta: 'Hi' } }),
      )
      t.publish(
        frame({ crumb: { type: 'text:delta', agentId: 'a', runId: 'r1', sessionId: 's', timestamp: 2, delta: ' there' } }),
      )
    })
    expect(out).toBe('agent ▸ Hi there')
  })

  test('labels the first reasoning:delta of a run and dims the reasoning text', () => {
    const t = transport()
    const { out } = captureWrites(() => {
      t.publish(
        frame({
          crumb: { type: 'reasoning:delta', agentId: 'a', runId: 'r1', sessionId: 's', timestamp: 1, delta: 'Hmm' },
        }),
      )
      t.publish(
        frame({
          crumb: { type: 'reasoning:delta', agentId: 'a', runId: 'r1', sessionId: 's', timestamp: 2, delta: '…' },
        }),
      )
    })
    expect(out).toBe('agent ▸ \x1b[2mHmm\x1b[0m\x1b[2m…\x1b[0m')
  })

  test('tool:call is silent by default and prints only when traced', () => {
    const toolCrumb = {
      type: 'tool:call' as const,
      agentId: 'a',
      runId: 'r1',
      sessionId: 's',
      timestamp: 1,
      toolCallId: 'c1',
      toolName: 'search',
      args: { q: 'x' },
    }

    const { out: silentOut } = captureWrites(() => transport().publish(frame({ crumb: toolCrumb })))
    expect(silentOut).toBe('')

    const { out: tracedOut } = captureWrites(() =>
      transport({ trace: true }).publish(frame({ crumb: toolCrumb })),
    )
    expect(tracedOut).toContain('search({"q":"x"})')
  })

  test('file:generated prints unconditionally, unlike traced-only tool:call', () => {
    const t = transport()
    const { out } = captureWrites(() => {
      t.publish(
        frame({
          crumb: {
            type: 'file:generated',
            agentId: 'a',
            runId: 'r1',
            sessionId: 's',
            timestamp: 1,
            uri: 'https://blob.example/cat.png',
            mimeType: 'image/png',
          },
        }),
      )
    })
    expect(out).toContain('generated file: https://blob.example/cat.png (image/png)')
  })

  test('agent:run:end prints a generated-file line when output is a tool-echoed FileOutput', () => {
    const t = transport()
    const { out } = captureWrites(() => {
      t.publish(
        frame({
          crumb: {
            type: 'agent:run:end',
            agentId: 'a',
            runId: 'r1',
            sessionId: 's',
            timestamp: 1,
            output: { kind: 'file', uri: 'https://blob.example/report.pdf', mimeType: 'application/pdf' },
            durationMs: 10,
          },
        }),
      )
    })
    expect(out).toContain('generated file: https://blob.example/report.pdf (application/pdf)')
  })

  test('agent:run:end with plain text output prints nothing extra', () => {
    const t = transport()
    const { out } = captureWrites(() => {
      t.publish(
        frame({
          crumb: {
            type: 'agent:run:end',
            agentId: 'a',
            runId: 'r1',
            sessionId: 's',
            timestamp: 1,
            output: 'plain text answer',
            durationMs: 10,
          },
        }),
      )
    })
    expect(out).toBe('')
  })

  test('tool:error and agent:error print to stderr', () => {
    const t = transport()
    const { err } = captureWrites(() => {
      t.publish(
        frame({
          crumb: {
            type: 'tool:error',
            agentId: 'a',
            runId: 'r1',
            sessionId: 's',
            timestamp: 1,
            toolCallId: 'c1',
            toolName: 'search',
            error: new BreadError('boom', 'TOOL_FAILED'),
            durationMs: 5,
          },
        }),
      )
      t.publish(
        frame({
          crumb: {
            type: 'agent:error',
            agentId: 'a',
            runId: 'r1',
            timestamp: 2,
            error: new BreadError('kaboom', 'AGENT_FAILED'),
          },
        }),
      )
    })
    expect(err).toContain('search failed: boom')
    expect(err).toContain('agent error: kaboom')
  })

  test('human:required resets the label so the next text:delta re-labels', () => {
    const t = transport()
    const { out } = captureWrites(() => {
      t.publish(
        frame({ crumb: { type: 'text:delta', agentId: 'a', runId: 'r1', sessionId: 's', timestamp: 1, delta: 'Hi' } }),
      )
      t.publish(
        frame({
          crumb: {
            type: 'human:required',
            agentId: 'a',
            runId: 'r1',
            sessionId: 's',
            timestamp: 2,
            checkpointId: 'ckpt1',
            toolName: 'ask',
            schema: {},
            kind: 'input',
          },
        }),
      )
      t.publish(
        frame({ crumb: { type: 'text:delta', agentId: 'a', runId: 'r1', sessionId: 's', timestamp: 3, delta: 'Hi again' } }),
      )
    })
    expect(out).toBe('agent ▸ Hiagent ▸ Hi again')
  })
})
