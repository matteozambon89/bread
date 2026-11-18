import { resolve } from 'node:path'

export interface ServeFlags {
  command: 'dev' | 'start'
  cwd: string
  port?: number
  host?: string
  idleTimeout?: number
  noMigrate?: boolean
}

export function parseServeArgs(argv: string[], fallbackCwd = process.cwd()): ServeFlags {
  const command = argv[0]
  if (command !== 'dev' && command !== 'start') {
    throw new Error(
      'Usage: bread-runtime-node <dev|start> [--cwd <dir>] [--port <n>] [--host <host>] [--idle-timeout <seconds>] [--no-migrate]',
    )
  }

  let cwd = fallbackCwd
  let port: number | undefined
  let host: string | undefined
  let idleTimeout: number | undefined
  let noMigrate = false

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
    } else if (arg === '--no-migrate') {
      noMigrate = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return {
    command,
    cwd,
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(idleTimeout !== undefined ? { idleTimeout } : {}),
    ...(noMigrate ? { noMigrate: true } : {}),
  }
}
