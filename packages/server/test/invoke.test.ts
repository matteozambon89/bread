import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { runInvoke } from '@breadai/server'
import { mockToolCallModel, mockTextModel } from '@breadai/test-utils'

const projectRoot = join(import.meta.dir, 'fixtures', 'invoke-project')
const noTransportRoot = join(import.meta.dir, 'fixtures', 'invoke-project-no-transport')

function setModel(model: unknown): void {
  ;(globalThis as Record<string, unknown>)['__breadInvokeTestModel'] = model
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__breadInvokeTestModel']
})

// Captures stdout/stderr writes made by `fn` — mirrors
// transports/stdout/test/stdout.test.ts's helper, made async-aware since
// runInvoke is a promise.
async function captureWrites(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
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
    await fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { out, err }
}

class ProcessExitSignal extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

// Stubs process.exit for the duration of `fn`, turning a real exit attempt
// into a catchable signal instead of killing the test process.
async function withStubbedExit<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.exit
  process.exit = ((code?: number) => {
    throw new ProcessExitSignal(code ?? 0)
  }) as never
  try {
    return await fn()
  } finally {
    process.exit = orig
  }
}

describe('runInvoke', () => {
  test('text:delta streams to stdout and agent:run:end supplies the final output', async () => {
    setModel(mockTextModel('hello there'))
    const { out } = await captureWrites(() =>
      runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'hi' }),
    )
    expect(out).toBe('hello there\n')
  })

  test('json mode suppresses per-delta stdout and prints only the final JSON output', async () => {
    setModel(mockTextModel('hello there'))
    const { out } = await captureWrites(() =>
      runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'hi', json: true }),
    )
    expect(out).toBe('"hello there"\n')
  })

  test('tool:call crumb prints a trace line to stderr when --trace is set', async () => {
    setModel(mockToolCallModel({ toolName: 'tool_echo', args: { text: 'hi' }, then: 'done' }))
    const { out, err } = await captureWrites(() =>
      runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'go', trace: true }),
    )
    expect(err).toContain('echo({"text":"hi"})')
    expect(out).toBe('done\n')
  })

  test('tool:call produces no trace output when --trace is unset', async () => {
    setModel(mockToolCallModel({ toolName: 'tool_echo', args: { text: 'hi' }, then: 'done' }))
    const { err } = await captureWrites(() =>
      runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'go' }),
    )
    expect(err).toBe('')
  })

  test('human:required crumb prints a non-interactive notice to stderr and exits with code 1', async () => {
    setModel(mockToolCallModel({ toolName: 'human_confirm', args: { ok: true }, then: 'unused' }))

    let signal: ProcessExitSignal | undefined
    const { err } = await captureWrites(() =>
      withStubbedExit(async () => {
        try {
          await runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'go' })
        } catch (thrown) {
          signal = thrown as ProcessExitSignal
        }
      }),
    )

    expect(signal).toBeInstanceOf(ProcessExitSignal)
    expect(signal!.code).toBe(1)
    expect(err).toContain('requires human input via tool "human_confirm"')
    expect(err).toContain('`invoke` is non-interactive')
  })

  test('rejects with a clear error when the agent id is unknown', async () => {
    setModel(mockTextModel('unused'))
    await expect(runInvoke({ cwd: projectRoot, agentId: 'ghost', input: 'hi' })).rejects.toThrow(
      /Agent "ghost" not found/,
    )
  })

  test('throws TRANSPORT_NOT_CONFIGURED when config.transport is unset', async () => {
    setModel(mockTextModel('unused'))
    await expect(runInvoke({ cwd: noTransportRoot, agentId: 'agent', input: 'hi' })).rejects.toThrow(
      /No transport configured/,
    )
  })
})
