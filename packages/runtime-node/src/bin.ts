#!/usr/bin/env node
/**
 * Node listen entry for the Bun-hosted CLI's `--runtime node` spawn path.
 *
 * The parent `bread` process must not import `@hono/node-server` in-process;
 * it spawns this bin under `node` instead. Loads the project via
 * `@breadai/server` and listens with `startServerNode`.
 *
 * Project `.ts` sources need a Node that can import them (Node ≥22.18 with
 * type stripping). engines.node is >=22.18.
 */
import { resolve } from 'node:path'
import { runDev, runStart } from '@breadai/server'
import { startServerNode } from './start.js'

interface ServeFlags {
  command: 'dev' | 'start'
  cwd: string
  port?: number
  host?: string
  idleTimeout?: number
}

function usage(): never {
  console.error(
    'Usage: bread-runtime-node <dev|start> [--cwd <dir>] [--port <n>] [--host <host>] [--idle-timeout <seconds>]',
  )
  process.exit(1)
}

function parseArgs(argv: string[]): ServeFlags {
  const command = argv[0]
  if (command !== 'dev' && command !== 'start') usage()

  let cwd = process.cwd()
  let port: number | undefined
  let host: string | undefined
  let idleTimeout: number | undefined

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--cwd' && next !== undefined) {
      cwd = resolve(next)
      i++
    } else if (arg === '--port' && next !== undefined) {
      port = parseInt(next, 10)
      i++
    } else if (arg === '--host' && next !== undefined) {
      host = next
      i++
    } else if (arg === '--idle-timeout' && next !== undefined) {
      idleTimeout = parseInt(next, 10)
      i++
    } else {
      console.error(`[bread] Unknown argument: ${arg}`)
      usage()
    }
  }

  return {
    command,
    cwd,
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(idleTimeout !== undefined ? { idleTimeout } : {}),
  }
}

function assertNodeCanStripTypes(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  if (major > 22 || (major === 22 && minor >= 18)) return
  // runDev/runStart import bread.config.ts; older Node fails that import
  // without a type-stripping message unless we refuse first.
  console.error(
    `[bread] Node ${process.versions.node} cannot import bread.config.ts (type stripping requires Node >=22.18).`,
  )
  process.exit(1)
}

function isUnknownBunBuiltin(err: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const code = 'code' in current ? String((current as { code: unknown }).code) : ''
    const message = current instanceof Error ? current.message : ''
    if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /No such built-in module:\s*bun:/.test(message)) {
      return true
    }
    // Node rejects `import` of bun:sqlite as an unsupported URL scheme, not an unknown builtin.
    if (code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME' && message.includes("protocol 'bun:'")) {
      return true
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined
  }
  return false
}

async function main(): Promise<void> {
  assertNodeCanStripTypes()
  const flags = parseArgs(process.argv.slice(2))
  try {
    process.chdir(flags.cwd)
  } catch {
    console.error(`[bread] --cwd directory does not exist: ${flags.cwd}`)
    process.exit(1)
  }

  // runDev/runStart only call stop() from a SIGINT listener.
  process.on('SIGTERM', () => {
    process.kill(process.pid, 'SIGINT')
  })

  const opts = {
    cwd: flags.cwd,
    listen: startServerNode,
    ...(flags.port !== undefined ? { port: flags.port } : {}),
    ...(flags.host !== undefined ? { host: flags.host } : {}),
    ...(flags.idleTimeout !== undefined ? { idleTimeout: flags.idleTimeout } : {}),
  }

  if (flags.command === 'dev') {
    await runDev(opts)
  } else {
    await runStart(opts)
  }
}

main().catch((err) => {
  if (isUnknownBunBuiltin(err)) {
    console.error(
      '[bread] This Node child loads bread.config.ts and agents, so a bun: builtin such as bun:sqlite (@breadai/store-sqlite) cannot load. Use the postgres or memory store.',
    )
  }
  console.error('[bread]', err instanceof Error ? err.message : err)
  process.exit(1)
})
