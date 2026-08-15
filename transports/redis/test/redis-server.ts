import { type ChildProcess, spawn } from 'node:child_process'
import net from 'node:net'

export interface RedisTestServer {
  url: string
  stop(): void
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

// Spawns a local `redis-server` binary on an ephemeral port and waits for it
// to accept connections before resolving. Callers determine availability
// (REDIS_URL env var vs Bun.which('redis-server')) themselves, synchronously,
// before test registration — bun:test registers describe/test blocks at
// module-evaluation time, before any beforeAll runs, so the skip-vs-run
// decision can't live inside this (necessarily async) spawn helper.
export async function spawnRedisForTest(binary: string): Promise<RedisTestServer> {
  const port = await freePort()
  // Ephemeral, persistence-free instance — nothing touches disk. Spawned via
  // node:child_process: bun test's dangling-process reaper kills Bun.spawn'd
  // children when the spawning hook returns, which would take the server down
  // before any case runs.
  const server: ChildProcess = spawn(binary, ['--port', String(port), '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  })
  const url = `redis://127.0.0.1:${port}`
  // Wait for the socket to accept before the first case connects.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' })
        sock.once('connect', () => sock.end(resolve))
        sock.once('error', reject)
      })
      break
    } catch {
      if (Date.now() > deadline) throw new Error('spawned redis-server never became reachable')
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return { url, stop: () => server.kill() }
}
