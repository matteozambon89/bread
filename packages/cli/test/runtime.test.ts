import { describe, expect, test } from 'bun:test'
import {
  RUNTIME_PACKAGES,
  nodeServeArgv,
  parseRuntime,
  resolveRuntime,
  resolveRuntimeNodeBin,
  spawnNodeServe,
} from '../src/runtime.js'

describe('RUNTIME_PACKAGES', () => {
  test('maps bun and node only', () => {
    expect(RUNTIME_PACKAGES).toEqual({
      bun: '@breadai/runtime-bun',
      node: '@breadai/runtime-node',
    })
    expect(Object.keys(RUNTIME_PACKAGES).sort()).toEqual(['bun', 'node'])
  })
})

describe('parseRuntime', () => {
  test('accepts bun and node', () => {
    expect(parseRuntime('bun')).toBe('bun')
    expect(parseRuntime('node')).toBe('node')
  })

  test('rejects unsupported names', () => {
    expect(() => parseRuntime('deno')).toThrow(/Unsupported --runtime/)
    expect(() => parseRuntime('workers')).toThrow(/Unsupported --runtime/)
  })
})

describe('resolveRuntime', () => {
  test('--runtime flag beats config.server.runtime', async () => {
    const runtime = await resolveRuntime({
      flag: 'node',
      cwd: '/tmp',
      loadConfig: async () => ({ server: { runtime: 'bun' } }),
    })
    expect(runtime).toBe('node')
  })

  test('falls through to config.server.runtime when flag omitted', async () => {
    const runtime = await resolveRuntime({
      cwd: '/tmp',
      loadConfig: async () => ({ server: { runtime: 'node' } }),
    })
    expect(runtime).toBe('node')
  })

  test('defaults to bun when flag and config omit runtime', async () => {
    const runtime = await resolveRuntime({
      cwd: '/tmp',
      loadConfig: async () => ({}),
    })
    expect(runtime).toBe('bun')
  })

  test('throws when config.server.runtime is unsupported', async () => {
    await expect(
      resolveRuntime({
        cwd: '/tmp',
        loadConfig: async () => ({ server: { runtime: 'deno' } }),
      }),
    ).rejects.toThrow(/Unsupported --runtime/)
  })
})

describe('nodeServeArgv', () => {
  test('builds node + bin + command + flags', () => {
    const argv = nodeServeArgv(
      {
        command: 'start',
        cwd: '/proj',
        port: 8080,
        host: '0.0.0.0',
        idleTimeout: 30,
      },
      '/abs/dist/bin.js',
    )
    expect(argv).toEqual([
      'node',
      '/abs/dist/bin.js',
      'start',
      '--cwd',
      '/proj',
      '--port',
      '8080',
      '--host',
      '0.0.0.0',
      '--idle-timeout',
      '30',
    ])
  })

  test('omits unset serve overrides', () => {
    const argv = nodeServeArgv({ command: 'dev', cwd: '/proj' }, '/abs/dist/bin.js')
    expect(argv).toEqual(['node', '/abs/dist/bin.js', 'dev', '--cwd', '/proj'])
  })
})

describe('resolveRuntimeNodeBin', () => {
  test('throws a build message when dist/bin.js is missing', () => {
    expect(() =>
      resolveRuntimeNodeBin(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
    ).toThrow(/Build @breadai\/runtime-node or reinstall/)
  })
})

describe('spawnNodeServe', () => {
  test('spawns node with the runtime-node bin and exits with the child code', async () => {
    const calls: unknown[] = []
    let exitedCode: number | undefined

    const fakeProc = {
      kill() {},
      exited: Promise.resolve(7),
    }

    const spawn = ((opts: unknown) => {
      calls.push(opts)
      return fakeProc
    }) as unknown as typeof Bun.spawn

    const exit = ((code: number) => {
      exitedCode = code
      throw new Error(`exit:${code}`)
    }) as (code: number) => never

    await expect(
      spawnNodeServe(
        { command: 'start', cwd: '/proj', port: 3001, host: '127.0.0.1' },
        spawn,
        exit,
      ),
    ).rejects.toThrow('exit:7')

    expect(exitedCode).toBe(7)
    expect(calls).toHaveLength(1)
    const spawnOpts = calls[0] as { cmd: string[]; cwd: string }
    expect(spawnOpts.cwd).toBe('/proj')
    expect(spawnOpts.cmd[0]).toBe('node')
    expect(spawnOpts.cmd[1]).toMatch(/runtime-node[/\\]dist[/\\]bin\.js$/)
    expect(spawnOpts.cmd.slice(2)).toEqual([
      'start',
      '--cwd',
      '/proj',
      '--port',
      '3001',
      '--host',
      '127.0.0.1',
    ])
  })

  test('forwards SIGINT to the child as SIGINT', async () => {
    const kills: Array<string | number | undefined> = []
    let resolveExited: (code: number) => void = () => {}
    const fakeProc = {
      kill(signal?: string | number) {
        kills.push(signal)
      },
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve
      }),
    }
    const before = new Set(process.listeners('SIGINT'))
    const spawn = (() => fakeProc) as unknown as typeof Bun.spawn
    const exit = ((code: number) => {
      throw new Error(`exit:${code}`)
    }) as (code: number) => never

    const pending = spawnNodeServe({ command: 'dev', cwd: '/proj' }, spawn, exit)
    const added = process.listeners('SIGINT').filter((listener) => !before.has(listener))
    expect(added).toHaveLength(1)
    ;(added[0] as () => void)()
    expect(kills).toEqual(['SIGINT'])

    resolveExited(0)
    await expect(pending).rejects.toThrow('exit:0')
    expect(process.listeners('SIGINT').filter((listener) => !before.has(listener))).toHaveLength(0)
  })
})
