import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { FIXTURES, spawnCli } from './spawn-helper.js'

// `bread start`'s port/host flags at the binary level — Commander parsing,
// the flag-beats-config precedence documented in cli.ts's serveOverrides()
// comment, and the HTTP auth bind gate through the real CLI.

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

  test('binding loopback warns that a reverse proxy can present a loopback Host', async () => {
    const port = freePort()
    cli = spawnCli(['start', '--port', String(port), '--host', '127.0.0.1', '--cwd', serveProject])
    await cli.readUntil('Listening on')
    const deadline = Date.now() + 2000
    while (!cli.stderrSoFar().includes('reverse proxy') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(cli.stderrSoFar()).toContain('reverse proxy')
    expect(cli.stderrSoFar()).toContain('[::1]')
  }, 10000)

  test('binding non-loopback with no auth plugin refuses to listen', async () => {
    const port = freePort()
    cli = spawnCli(['start', '--port', String(port), '--host', '0.0.0.0', '--cwd', serveProject])
    const code = await cli.proc.exited
    expect(code).toBe(1)
    const deadline = Date.now() + 2000
    while (!cli.stderrSoFar().includes('spoofed Host') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(cli.stderrSoFar()).toContain('authPlugin')
    expect(cli.stderrSoFar()).toContain('spoofed Host')
    expect(cli.stdoutSoFar()).not.toContain('Listening on')
  }, 10000)
})
