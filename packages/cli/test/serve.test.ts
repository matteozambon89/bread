import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { FIXTURES, spawnCli } from './spawn-helper.js'

// `bread start`'s port/host flags at the binary level — Commander parsing,
// the flag-beats-config precedence documented in cli.ts's serveOverrides()
// comment, and (since it's reachable from here) the Phase 2 non-loopback
// bind warning actually firing through the real CLI, not just the in-process
// startServer unit test in packages/server/test/bind-warning.test.ts.

const serveProject = resolve(FIXTURES, 'serve-project')

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

describe('bread start — port/host flags', () => {
  let cli: ReturnType<typeof spawnCli> | undefined

  afterEach(() => {
    cli?.proc.kill()
    cli = undefined
  })

  test('an explicit --port overrides config.server.port (41999)', async () => {
    const port = freePort()
    cli = spawnCli(['start', '--port', String(port), '--host', '127.0.0.1', '--cwd', serveProject])
    await cli.readUntil('Listening on')
    expect(cli.stdoutSoFar()).toContain(`http://127.0.0.1:${port}`)
    expect(cli.stdoutSoFar()).not.toContain(':41999')

    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res.status).toBe(200)
  }, 10000)

  test('an omitted --port falls through to config.server.port', async () => {
    cli = spawnCli(['start', '--host', '127.0.0.1', '--cwd', serveProject])
    await cli.readUntil('Listening on')
    expect(cli.stdoutSoFar()).toContain(':41999')
  }, 10000)

  test('binding loopback prints no non-loopback warning', async () => {
    const port = freePort()
    cli = spawnCli(['start', '--port', String(port), '--host', '127.0.0.1', '--cwd', serveProject])
    await cli.readUntil('Listening on')
    expect(cli.stderrSoFar()).not.toContain('WARNING')
  }, 10000)

  test('binding non-loopback with no auth plugin prints the Phase-2 warning, reachable through the real binary', async () => {
    const port = freePort()
    cli = spawnCli(['start', '--port', String(port), '--host', '0.0.0.0', '--cwd', serveProject])
    await cli.readUntil('Listening on')
    expect(cli.stderrSoFar()).toContain('WARNING')
    expect(cli.stderrSoFar()).toContain('0.0.0.0')
  }, 10000)
})
