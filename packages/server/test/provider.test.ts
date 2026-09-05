import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { runProviderAdd, runProviderList } from '@breadai/server'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function writeManifest(deps: Record<string, string> = {}): string {
  dir = mkdtempSync(join(tmpdir(), 'bread-provider-test-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }))
  return dir
}

describe('runProviderAdd', () => {
  test('throws on an unknown provider name', async () => {
    const cwd = writeManifest()
    await expect(runProviderAdd({ cwd, name: 'not-a-real-provider' })).rejects.toThrow(/Unknown provider/)
  })

  test('throws when package.json is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bread-provider-test-'))
    await expect(runProviderAdd({ cwd: dir, name: 'ollama' })).rejects.toThrow(/No package.json found/)
  })

  test('skips install when the package is already a dependency', async () => {
    const cwd = writeManifest({ 'ollama-ai-provider-v2': '^4.0.0' })
    // No network call happens here: the already-installed branch returns
    // before `bun add` would ever be spawned.
    await expect(runProviderAdd({ cwd, name: 'ollama' })).resolves.toBeUndefined()
  })
})

describe('runProviderAdd — install path (Bun.spawn stubbed)', () => {
  const originalSpawn = Bun.spawn
  const originalEnv = { ...process.env }

  afterEach(() => {
    Bun.spawn = originalSpawn
    process.env = { ...originalEnv }
  })

  function stubSpawn(exitCode: number): { calls: unknown[][] } {
    const calls: unknown[][] = []
    Bun.spawn = ((...args: unknown[]) => {
      calls.push(args)
      return { exited: Promise.resolve(exitCode) }
    }) as unknown as typeof Bun.spawn
    return { calls }
  }

  test('spawns `bun add <pkg>` and succeeds when the exit code is 0', async () => {
    const cwd = writeManifest()
    const { calls } = stubSpawn(0)

    await expect(runProviderAdd({ cwd, name: 'ollama' })).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toEqual(['bun', 'add', 'ollama-ai-provider-v2'])
  })

  test('throws PROVIDER_INSTALL_FAILED when `bun add` exits non-zero', async () => {
    const cwd = writeManifest()
    stubSpawn(1)

    await expect(runProviderAdd({ cwd, name: 'ollama' })).rejects.toMatchObject({
      code: 'PROVIDER_INSTALL_FAILED',
    })
  })

  test('prints the missing env vars after a successful install when some are unset', async () => {
    const cwd = writeManifest()
    stubSpawn(0)
    delete process.env['OPENAI_API_KEY']
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))

    try {
      await runProviderAdd({ cwd, name: 'openai' })
    } finally {
      console.log = origLog
    }

    const printed = logs.join('\n')
    expect(printed).toContain('openai reads: OPENAI_API_KEY')
    expect(printed).toContain('Not currently set: OPENAI_API_KEY')
  })

  test('skips the env-vars line entirely for a zero-config provider', async () => {
    const cwd = writeManifest()
    stubSpawn(0)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))

    try {
      await runProviderAdd({ cwd, name: 'ollama' })
    } finally {
      console.log = origLog
    }

    const printed = logs.join('\n')
    expect(printed).toContain('ollama needs no env vars (zero-config)')
    expect(printed).not.toContain('reads:')
  })
})

describe('runProviderList', () => {
  test('throws when package.json is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bread-provider-test-'))
    await expect(runProviderList({ cwd: dir })).rejects.toThrow(/No package.json found/)
  })

  test('resolves for a project with a package.json', async () => {
    const cwd = writeManifest()
    await expect(runProviderList({ cwd })).resolves.toBeUndefined()
  })
})
