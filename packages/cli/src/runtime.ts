import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { ListenFn } from '@breadai/server'

/** Supported CLI listen runtimes — bun + node only (no Deno / Workers / AgentCore). */
export type ServeRuntime = 'bun' | 'node'

/** Map CLI/config runtime name → npm package that exports the ListenFn. */
export const RUNTIME_PACKAGES = {
  bun: '@breadai/runtime-bun',
  node: '@breadai/runtime-node',
} as const satisfies Record<ServeRuntime, string>

const require = createRequire(import.meta.url)

export function parseRuntime(value: string): ServeRuntime {
  if (value === 'bun' || value === 'node') return value
  throw new Error(
    `Unsupported --runtime "${value}". Supported: bun, node.`,
  )
}

/**
 * Resolve the listen runtime: `--runtime` flag beats `config.server.runtime`,
 * which beats the Bun-hosted CLI default (`bun`).
 */
export async function resolveRuntime(opts: {
  flag?: string | undefined
  cwd: string
  /** Injected so unit tests don't need a real bread.config.ts. */
  loadConfig: (cwd: string) => Promise<{ server?: { runtime?: string } }>
}): Promise<ServeRuntime> {
  if (opts.flag !== undefined && opts.flag !== '') {
    return parseRuntime(opts.flag)
  }
  const config = await opts.loadConfig(opts.cwd)
  const configured = config.server?.runtime
  if (configured === undefined || configured === '') return 'bun'
  return parseRuntime(configured)
}

/**
 * In-process ListenFn for the Bun-hosted CLI when runtime is `bun`.
 * Never import `@breadai/runtime-node` / `@hono/node-server` here — that
 * poisons Bun.serve Response handling in the same process; use spawn instead.
 */
export async function loadBunListen(): Promise<ListenFn> {
  try {
    const mod = await import('@breadai/runtime-bun')
    return mod.startServer
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to load ${RUNTIME_PACKAGES.bun}. Install it as a dependency of @breadai/cli. ${detail}`,
    )
  }
}

/** Absolute path to `@breadai/runtime-node`'s published bin (dist), for Node spawn. */
export function resolveRuntimeNodeBin(stat: (path: string) => void = statSync): string {
  let pkgJson: string
  try {
    pkgJson = require.resolve(`${RUNTIME_PACKAGES.node}/package.json`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to resolve ${RUNTIME_PACKAGES.node}. Install it as a dependency ` +
        `(optional peer of @breadai/cli) when using --runtime node. ${detail}`,
    )
  }
  const bin = resolve(dirname(pkgJson), 'dist/bin.js')
  try {
    stat(bin)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${RUNTIME_PACKAGES.node} bin not found at ${bin}. Build @breadai/runtime-node or reinstall so dist/bin.js exists. ${detail}`,
    )
  }
  return bin
}

export interface ServeSpawnOpts {
  command: 'dev' | 'start'
  cwd: string
  port?: number | undefined
  host?: string | undefined
  idleTimeout?: number | undefined
}

/** Build the `node … dist/bin.js <command> …` argv for a Node listen child. */
export function nodeServeArgv(opts: ServeSpawnOpts, bin = resolveRuntimeNodeBin()): string[] {
  const argv = ['node', bin, opts.command, '--cwd', opts.cwd]
  if (opts.port !== undefined) argv.push('--port', String(opts.port))
  if (opts.host !== undefined) argv.push('--host', opts.host)
  if (opts.idleTimeout !== undefined) argv.push('--idle-timeout', String(opts.idleTimeout))
  return argv
}

/**
 * Spawn a Node child that runs `@breadai/runtime-node`'s bin (startServerNode
 * via @hono/node-server). The Bun-hosted CLI must not call @hono/node-server
 * in-process.
 *
 * `spawn` is injectable for unit tests.
 */
export async function spawnNodeServe(
  opts: ServeSpawnOpts,
  spawn: typeof Bun.spawn = Bun.spawn.bind(Bun),
  exit: (code: number) => never = ((code) => {
    process.exit(code)
    throw new Error('unreachable')
  }) as (code: number) => never,
): Promise<never> {
  const cmd = nodeServeArgv(opts)
  const proc = spawn({
    cmd,
    cwd: opts.cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env },
  })

  const forward = (signal: 'SIGINT' | 'SIGTERM') => {
    try {
      proc.kill(signal)
    } catch {
      // Child may have already exited.
    }
  }
  const onSigint = () => forward('SIGINT')
  const onSigterm = () => forward('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  const code = await proc.exited
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  return exit(code ?? 1)
}
