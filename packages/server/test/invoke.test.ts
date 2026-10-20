import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, test } from 'bun:test'
import { LOCAL_CLI_PRINCIPAL } from '@breadai/core'
import type { BreadStore } from '@breadai/core'
import { runChat, runInvoke } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { defineTestAgent, makeServer, mockTextModel, mockToolCallModel, runCollect } from '@breadai/test-utils'

const projectRoot = join(import.meta.dir, 'fixtures', 'invoke-project')
const noTransportRoot = join(import.meta.dir, 'fixtures', 'invoke-project-no-transport')

function setModel(model: unknown): void {
  ;(globalThis as Record<string, unknown>)['__breadInvokeTestModel'] = model
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__breadInvokeTestModel']
  delete (globalThis as Record<string, unknown>)['__breadInvokePrincipal']
  delete (globalThis as Record<string, unknown>)['__breadInvokeStore']
})

async function withScriptedStdin(lines: string[], fn: () => Promise<void>): Promise<void> {
  const stdin = process.stdin
  const before = new Set(process.listeners('SIGINT'))
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from(lines.map((line) => `${line}\n`)),
  })
  try {
    await fn()
  } finally {
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin })
    for (const listener of process.listeners('SIGINT')) {
      if (!before.has(listener)) process.removeListener('SIGINT', listener)
    }
  }
}

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

  test('passes the cli principal into the run', async () => {
    setModel(mockToolCallModel({ toolName: 'tool_echo', args: { text: 'hi' }, then: 'done' }))
    await captureWrites(() => runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'go' }))
    expect((globalThis as Record<string, unknown>)['__breadInvokePrincipal']).toEqual({
      iss: 'https://bread.local/cli',
      sub: 'local',
    })
  })

  test('throws TRANSPORT_NOT_CONFIGURED when config.transport is unset', async () => {
    setModel(mockTextModel('unused'))
    await expect(runInvoke({ cwd: noTransportRoot, agentId: 'agent', input: 'hi' })).rejects.toThrow(
      /No transport configured/,
    )
  })

  test('a no-auth http session resumes from chat and invoke and stays hidden from another iss or sub', async () => {
    const shared: BreadStore = store()
    ;(globalThis as { __breadInvokeStore?: BreadStore }).__breadInvokeStore = shared
    const sessionId = 'loopback-session'
    const { app, bread, stop } = await makeServer({
      agents: { agent: defineTestAgent() },
      model: mockTextModel('from-http'),
      config: { store: shared },
    })
    try {
      const res = await app.request('http://127.0.0.1/agents/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'hi', session: { id: sessionId } }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect((await shared.getSession(sessionId))?.principal).toEqual(LOCAL_CLI_PRINCIPAL)

      await expect(
        runCollect(bread, 'agent', 'nope', {
          principal: { iss: LOCAL_CLI_PRINCIPAL.iss, sub: 'other' },
          session: { id: sessionId },
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
      await expect(
        runCollect(bread, 'agent', 'nope', {
          principal: { iss: 'https://other.example', sub: LOCAL_CLI_PRINCIPAL.sub },
          session: { id: sessionId },
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })

      setModel(mockTextModel('from-invoke'))
      const { out } = await captureWrites(() =>
        runInvoke({ cwd: projectRoot, agentId: 'agent', input: 'again', session: sessionId }),
      )
      expect(out).toBe('from-invoke\n')

      setModel(mockTextModel('from-chat'))
      await withScriptedStdin(['hello'], () => runChat({ cwd: projectRoot, agentId: 'agent', session: sessionId }))
      expect((await shared.getMessages(sessionId)).map((message) => message.content)).toContain('hello')
      expect((await shared.getSession(sessionId))?.principal).toEqual(LOCAL_CLI_PRINCIPAL)
    } finally {
      delete (globalThis as Record<string, unknown>)['__breadInvokeStore']
      await stop()
    }
  })
})
