import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import { BreadError } from '@breadai/core'
import {
  createServer,
  loadAgents,
  loadConfig,
  loadEvals,
  runAgentAdd,
  runAgentEval,
  runBuild,
  runInit,
  runSkillAdd,
  runToolAdd,
} from '@breadai/server'
import type { AgentAddOptions } from '../src/commands/agent-add.js'
import type { InitOptions } from '../src/commands/init.js'
import { agentSource, evalSource, skillSource } from '../src/scaffold/templates.js'

const scratch = join(import.meta.dir, '.scaffold-work')
const dirs: string[] = []
const realWriteFile = fsPromises.writeFile.bind(fsPromises)

function initOpts(dir: string, over: Partial<Omit<InitOptions, 'dir'>> = {}): InitOptions {
  return {
    dir,
    runtime: 'bun',
    store: 'sqlite',
    transport: 'chunked',
    agent: 'assistant',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    noInstall: true,
    ...over,
  }
}

function addAgent(opts: Pick<AgentAddOptions, 'cwd' | 'id'> & Partial<Pick<AgentAddOptions, 'provider' | 'model'>>) {
  return runAgentAdd({ provider: 'anthropic', model: 'claude-opus-4-8', ...opts })
}

async function fresh(name: string): Promise<string> {
  const dir = join(scratch, name)
  await rm(dir, { recursive: true, force: true })
  dirs.push(dir)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(rel: string): Promise<void> {
    const abs = join(dir, rel)
    const info = await stat(abs)
    if (info.isDirectory()) {
      for (const entry of await readdir(abs)) await walk(rel ? join(rel, entry) : entry)
      return
    }
    out[rel] = await readFile(abs, 'utf8')
  }
  await walk('')
  return out
}

async function withSpawn(fn: (calls: unknown[]) => Promise<void>): Promise<void> {
  const calls: unknown[] = []
  const original = Bun.spawn
  Bun.spawn = ((cmd: unknown) => {
    calls.push(cmd)
    return { exited: Promise.resolve(0) }
  }) as typeof Bun.spawn
  try {
    await fn(calls)
  } finally {
    Bun.spawn = original
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('bread init', () => {
  test('default init writes server.runtime bun, sqlite, chunked, assistant, and package.json scripts that call bread', async () => {
    const dir = await fresh('default-init')
    await runInit(initOpts(dir))

    const config = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(config).toContain("server: { runtime: 'bun' }")
    expect(config).toContain("from '@breadai/store-sqlite'")
    expect(config).toContain("store({ path: './bread.db' })")
    expect(config).toContain("from '@breadai/transport-http-chunked'")
    expect(config).toContain("entrypoints: ['assistant']")
    expect(config).toContain('providerLlm')
    expect(config).not.toContain('@breadai/runtime-bun')

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('default-init')
    expect(pkg.type).toBe('module')
    expect(pkg.scripts).toEqual({
      dev: 'bread dev',
      build: 'bread build',
      start: 'bread start',
    })
    expect(pkg.dependencies).toEqual({
      '@breadai/core': '>=0.1.0 <1.0.0',
      '@breadai/provider-llm': '>=0.1.0 <1.0.0',
      '@breadai/store-sqlite': '>=0.1.0 <1.0.0',
      '@breadai/transport-http-chunked': '>=0.1.0 <1.0.0',
      zod: '^4.4.3',
    })
    expect(pkg.devDependencies).toEqual({ '@breadai/cli': '>=0.1.0 <1.0.0' })
    expect(pkg.engines).toBeUndefined()
    expect(JSON.stringify(pkg)).not.toContain('runtime-bun')

    expect(await readFile(join(dir, 'agents/assistant/agent.ts'), 'utf8')).toBe(
      agentSource('anthropic', 'claude-opus-4-8'),
    )
    expect(await readFile(join(dir, 'agents/assistant/agent.ts'), 'utf8')).not.toContain('process.env')
    const prompt = await readFile(join(dir, 'agents/assistant/prompt.md'), 'utf8')
    expect(prompt.trim().split('\n')).toHaveLength(1)
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.env\nbread.db\nbread.db-shm\nbread.db-wal\n',
    )
  })

  test('--runtime node writes runtime node, memory store, @breadai/runtime-node, engines.node >=22.18, and does not depend on store-sqlite', async () => {
    const dir = await fresh('node-init')
    await runInit(initOpts(dir, { runtime: 'node', store: 'memory' }))
    const config = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(config).toContain("server: { runtime: 'node' }")
    expect(config).toContain("from '@breadai/store-memory'")
    expect(config).toContain('store()')
    expect(config).not.toContain('store-sqlite')
    expect(config).not.toContain('bun:sqlite')
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@breadai/runtime-node']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.dependencies['@breadai/store-memory']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.dependencies['@breadai/store-sqlite']).toBeUndefined()
    expect(pkg.devDependencies['@breadai/store-sqlite']).toBeUndefined()
    expect(pkg.engines.node).toBe('>=22.18')
    expect(JSON.stringify(pkg)).not.toContain('store-sqlite')
    expect(JSON.stringify(pkg)).not.toContain('runtime-bun')
  })

  test('node plus sqlite throws and writes nothing', async () => {
    const dir = await fresh('node-sqlite')
    await expect(
      runInit(initOpts(dir, { runtime: 'node', store: 'sqlite' })),
    ).rejects.toThrow(/bun:sqlite/)
    expect(await exists(dir)).toBe(false)
  })

  test('node plus postgres writes the postgres store', async () => {
    const dir = await fresh('node-postgres')
    await runInit(initOpts(dir, { runtime: 'node', store: 'postgres' }))
    const config = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(config).toContain("from '@breadai/store-postgres'")
    expect(config).toContain('store()')
    expect(config).not.toContain('store-sqlite')
    expect(config).not.toContain('store-memory')
    expect(config).toContain("runtime: 'node'")
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@breadai/store-postgres']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.dependencies['@breadai/runtime-node']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.engines.node).toBe('>=22.18')
  })

  test('a second init throws and leaves files unchanged', async () => {
    const dir = await fresh('second-init')
    await runInit(initOpts(dir, { store: 'memory' }))
    const before = await snapshot(dir)
    await expect(runInit(initOpts(dir, { store: 'memory' }))).rejects.toMatchObject({
      code: 'SCAFFOLD_EXISTS',
    })
    expect(await snapshot(dir)).toEqual(before)
  })

  test('an existing package.json throws and writes nothing', async () => {
    const dir = await fresh('existing-pkg')
    await mkdir(dir)
    const original = '{ "name": "keep-me" }\n'
    await writeFile(join(dir, 'package.json'), original)
    await expect(runInit(initOpts(dir))).rejects.toMatchObject({ code: 'SCAFFOLD_EXISTS' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(original)
    expect(await exists(join(dir, 'bread.config.ts'))).toBe(false)
    expect(await exists(join(dir, 'agents'))).toBe(false)
    expect(await exists(join(dir, '.gitignore'))).toBe(false)
  })

  test('an existing agents directory throws and writes nothing', async () => {
    const dir = await fresh('existing-agents')
    await mkdir(join(dir, 'agents'), { recursive: true })
    await expect(runInit(initOpts(dir))).rejects.toMatchObject({ code: 'SCAFFOLD_EXISTS' })
    expect(await readdir(dir)).toEqual(['agents'])
    expect(await readdir(join(dir, 'agents'))).toEqual([])
  })

  test('a directory that contains only .git is allowed', async () => {
    const dir = await fresh('git-only')
    await mkdir(join(dir, '.git'), { recursive: true })
    await runInit(initOpts(dir, { store: 'memory' }))
    expect(await exists(join(dir, 'bread.config.ts'))).toBe(true)
    expect(await exists(join(dir, '.git'))).toBe(true)
  })

  test('--store memory and --transport sse change the import and the dependency', async () => {
    const dir = await fresh('memory-sse')
    await runInit(initOpts(dir, { store: 'memory', transport: 'sse' }))
    const config = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(config).toContain("from '@breadai/store-memory'")
    expect(config).toContain("from '@breadai/transport-http-sse'")
    expect(config).not.toContain('store-sqlite')
    expect(config).not.toContain('transport-http-chunked')
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@breadai/store-memory']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.dependencies['@breadai/transport-http-sse']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.dependencies['@breadai/store-sqlite']).toBeUndefined()
    expect(pkg.dependencies['@breadai/transport-http-chunked']).toBeUndefined()
  })

  test('--store postgres writes store() from @breadai/store-postgres', async () => {
    const dir = await fresh('postgres')
    await runInit(initOpts(dir, { store: 'postgres' }))
    const config = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(config).toContain("from '@breadai/store-postgres'")
    expect(config).toMatch(/store\(\)/)
    expect(config).not.toContain('./bread.db')
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@breadai/store-postgres']).toBe('>=0.1.0 <1.0.0')
    expect(pkg.dependencies['@breadai/runtime-node']).toBeUndefined()
  })

  test('an unknown provider throws UNKNOWN_PROVIDER and writes nothing', async () => {
    const dir = await fresh('bad-provider')
    await expect(runInit(initOpts(dir, { provider: 'not-real' }))).rejects.toMatchObject({
      code: 'UNKNOWN_PROVIDER',
    })
    expect(await exists(dir)).toBe(false)
  })

  test('constructor is not a catalog provider: init throws before any write or spawn', async () => {
    const dir = await fresh('constructor-provider')
    await withSpawn(async (calls) => {
      await expect(runInit(initOpts(dir, { provider: 'constructor', noInstall: false }))).rejects.toMatchObject({
        code: 'UNKNOWN_PROVIDER',
      })
      expect(calls).toEqual([])
    })
    expect(await exists(dir)).toBe(false)
    await mkdir(dir)
    await runInit(initOpts(dir, { store: 'memory' }))
    const before = await snapshot(dir)
    await withSpawn(async (calls) => {
      await expect(addAgent({ cwd: dir, id: 'writer', provider: 'constructor' })).rejects.toMatchObject({
        code: 'UNKNOWN_PROVIDER',
      })
      expect(calls).toEqual([])
    })
    expect(await snapshot(dir)).toEqual(before)
    expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)
  })

  test('a blank model throws and writes nothing', async () => {
    const dir = await fresh('blank-model')
    await expect(runInit(initOpts(dir, { model: '   ' }))).rejects.toThrow(/--model/)
    expect(await exists(dir)).toBe(false)
  })

  test('provider and model are written as JSON string literals', async () => {
    const dir = await fresh('json-model')
    const model = 'claude "sonnet"\nnext'
    await runInit(initOpts(dir, { provider: 'openai', model, store: 'memory' }))
    const source = await readFile(join(dir, 'agents/assistant/agent.ts'), 'utf8')
    expect(source).toBe(agentSource('openai', model))
    expect(source).toContain(JSON.stringify('openai'))
    expect(source).toContain(JSON.stringify(model))
    expect(source).not.toContain('BREAD_PROVIDER')
    expect(source).not.toContain('BREAD_MODEL')
  })

  test('success text names the chosen provider', async () => {
    const dir = await fresh('outro-provider')
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await runInit(initOpts(dir, { provider: 'openai', model: 'gpt-4o', store: 'memory' }))
    } finally {
      console.log = original
    }
    expect(lines.some((line) => line.includes('bread provider add openai'))).toBe(true)
    expect(lines.some((line) => line.includes('anthropic'))).toBe(false)
  })

  test('an existing .gitignore keeps its bytes and gains only missing scaffold lines', async () => {
    const dir = await fresh('gitignore-keep')
    await mkdir(dir)
    const original = '# keep\nnode_modules'
    await writeFile(join(dir, '.gitignore'), original)
    await runInit(initOpts(dir, { store: 'memory' }))
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe(
      `${original}\n.env\nbread.db\nbread.db-shm\nbread.db-wal\n`,
    )
    expect(await exists(join(dir, 'bread.config.ts'))).toBe(true)

    const full = await fresh('gitignore-full')
    await mkdir(full)
    const exact = '# keep\nnode_modules\n.env\nbread.db\nbread.db-shm\nbread.db-wal\n# tail\n'
    await writeFile(join(full, '.gitignore'), exact)
    await runInit(initOpts(full, { store: 'memory' }))
    expect(await readFile(join(full, '.gitignore'), 'utf8')).toBe(exact)
  })

  test('a failed write removes paths this call created and keeps a pre-existing .gitignore', async () => {
    const dir = await fresh('rollback-write')
    await mkdir(dir)
    const original = '# keep\n'
    const gitignore = join(dir, '.gitignore')
    await writeFile(gitignore, original)
    const configPath = join(dir, 'bread.config.ts')
    const spy = spyOn(fsPromises, 'writeFile').mockImplementation((async (path, data, opts) => {
      if (path === configPath) throw new Error('fail write')
      return realWriteFile(path, data, opts)
    }) as typeof fsPromises.writeFile)
    try {
      await expect(runInit(initOpts(dir, { store: 'memory' }))).rejects.toThrow(/fail write/)
    } finally {
      spy.mockRestore()
    }
    expect(await exists(join(dir, 'package.json'))).toBe(false)
    expect(await exists(configPath)).toBe(false)
    expect(await exists(join(dir, 'agents'))).toBe(false)
    expect(await readFile(gitignore, 'utf8')).toBe(original)
    expect((await readdir(dir)).filter((name) => name !== '.gitignore')).toEqual([])
  })

  test('--no-install does not spawn bun', async () => {
    const dir = await fresh('no-install')
    await withSpawn(async (calls) => {
      await runInit(initOpts(dir, { store: 'memory' }))
      expect(calls).toEqual([])
    })
  })

  test('a failed bun install leaves the files and says they were written and install failed', async () => {
    const dir = await fresh('install-fail')
    const calls: unknown[] = []
    const original = Bun.spawn
    Bun.spawn = ((cmd: unknown) => {
      calls.push(cmd)
      return { exited: Promise.resolve(1) }
    }) as typeof Bun.spawn
    try {
      let caught: unknown
      try {
        await runInit(initOpts(dir, { store: 'memory', noInstall: false }))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(BreadError)
      const error = caught as BreadError
      expect(error.code).toBe('SCAFFOLD_INSTALL_FAILED')
      expect(error.message).toMatch(/written/i)
      expect(error.message).toMatch(/install failed/i)
      expect(calls).toEqual([['bun', 'install']])
      expect(await exists(join(dir, 'bread.config.ts'))).toBe(true)
    } finally {
      Bun.spawn = original
    }
  })

  test('loadConfig plus loadAgents plus createServer app.request GET /agents returns the assistant, and runBuild does not throw', async () => {
    const dir = await fresh('serve')
    await runInit(initOpts(dir))
    // --no-install leaves deps unlinked. Point at the workspace packages so
    // loadConfig can import the template (server's node_modules has no sqlite).
    const linked = join(dir, 'node_modules', '@breadai')
    await mkdir(linked, { recursive: true })
    const repo = join(import.meta.dir, '../../..')
    await symlink(join(repo, 'stores/sqlite'), join(linked, 'store-sqlite'))
    await symlink(join(repo, 'transports/http-chunked'), join(linked, 'transport-http-chunked'))
    const previous = process.cwd()
    process.chdir(dir)
    try {
      const config = await loadConfig(dir)
      const agents = await loadAgents(dir, config.entrypoints)
      const { app, bread } = createServer(config, agents)
      try {
        const res = await app.request('/agents')
        expect(res.status).toBe(200)
        const body = (await res.json()) as Array<{ id: string; outputFormat: string }>
        expect(body.map((agent) => agent.id)).toEqual(['assistant'])
        expect(body[0]?.outputFormat).toBe('text')
      } finally {
        await bread.stop()
      }
      await runBuild({ cwd: dir })
    } finally {
      process.chdir(previous)
    }
  })
})

describe('scaffold add', () => {
  test('agent add writes the chosen provider and model and rejects an unknown provider before writing', async () => {
    const dir = await fresh('add-model')
    await runInit(initOpts(dir, { store: 'memory' }))
    await addAgent({ cwd: dir, id: 'writer', provider: 'openai', model: 'gpt-4o' })
    expect(await readFile(join(dir, 'agents/writer/agent.ts'), 'utf8')).toBe(agentSource('openai', 'gpt-4o'))
    const before = await snapshot(dir)
    await expect(addAgent({ cwd: dir, id: 'editor', provider: 'nope', model: 'x' })).rejects.toMatchObject({
      code: 'UNKNOWN_PROVIDER',
    })
    expect(await snapshot(dir)).toEqual(before)
    expect(await exists(join(dir, 'agents/editor'))).toBe(false)
  })

  test('agent add writer appends the id on a one-line entrypoints array and loadAgents returns both', async () => {
    const dir = await fresh('add-one-line')
    await runInit(initOpts(dir, { store: 'memory' }))
    await addAgent({ cwd: dir, id: 'writer' })
    const config = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(config).toContain("entrypoints: ['assistant', 'writer']")
    const agents = await loadAgents(dir, ['assistant', 'writer'])
    expect([...agents.keys()].sort()).toEqual(['assistant', 'writer'])
  })

  test('a multi-line quoted list gains one element and keeps the other lines', async () => {
    const dir = await fresh('add-multi')
    await mkdir(dir)
    const source = `import { defineConfig } from '@breadai/core'

export default defineConfig({
  entrypoints: [
    'assistant',
    "keeper",
  ],
})
`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await addAgent({ cwd: dir, id: 'writer' })
    const after = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    for (const line of source.split('\n')) {
      if (line.trim() === '') continue
      expect(after.split('\n')).toContain(line)
    }
    expect(after).toContain("    'writer'")
    expect(after).not.toContain('...')
  })

  test('a spread list is unchanged, no agents/writer directory, and the error names writer', async () => {
    const dir = await fresh('spread')
    await mkdir(dir)
    const source = `export default {\n  entrypoints: ['assistant', ...rest],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    let caught: unknown
    try {
      await addAgent({ cwd: dir, id: 'writer' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BreadError)
    const error = caught as BreadError
    expect(error.code).toBe('ENTRYPOINTS_UNEDITABLE')
    expect(error.message).toContain('writer')
    expect(error.message).toMatch(/by hand/i)
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(source)
    expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)
  })

  test('duplicate id and an existing agents/writer throw before any write', async () => {
    const dir = await fresh('duplicate')
    await runInit(initOpts(dir, { store: 'memory' }))
    const before = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    await expect(addAgent({ cwd: dir, id: 'assistant' })).rejects.toMatchObject({
      code: 'SCAFFOLD_EXISTS',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(before)

    await mkdir(join(dir, 'agents', 'writer'))
    await writeFile(join(dir, 'agents', 'writer', 'keep.txt'), 'keep')
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'SCAFFOLD_EXISTS',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(before)
    expect(await readFile(join(dir, 'agents', 'writer', 'keep.txt'), 'utf8')).toBe('keep')
    expect(await exists(join(dir, 'agents', 'writer', 'agent.ts'))).toBe(false)
    expect(await exists(join(dir, 'agents', 'writer', 'prompt.md'))).toBe(false)

    const listed = before.replace("entrypoints: ['assistant']", "entrypoints: ['assistant', 'ghost']")
    await writeFile(join(dir, 'bread.config.ts'), listed)
    await expect(addAgent({ cwd: dir, id: 'ghost' })).rejects.toMatchObject({
      code: 'SCAFFOLD_EXISTS',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(listed)
    expect(await exists(join(dir, 'agents', 'ghost'))).toBe(false)
  })

  test('tool add, tool add --human, and skill add show up as _tools, _humanTools, and _skills', async () => {
    const dir = await fresh('tools-skills')
    await runInit(initOpts(dir, { store: 'memory' }))
    await runToolAdd({ cwd: dir, agent: 'assistant', name: 'lookup' })
    await runToolAdd({ cwd: dir, agent: 'assistant', name: 'approve', human: true })
    await runSkillAdd({ cwd: dir, agent: 'assistant', id: 'greet_user' })
    const agents = await loadAgents(dir, ['assistant'])
    const cfg = agents.get('assistant')!.config as {
      _tools: Array<{ name: string }>
      _humanTools: Array<{ name: string; _human: true }>
      _skills: Array<{ id: string; meta: { name: string; description: string } }>
    }
    expect(cfg._tools.map((tool) => tool.name)).toEqual(['lookup'])
    expect(cfg._humanTools.map((tool) => tool.name)).toEqual(['approve'])
    expect(cfg._humanTools[0]?._human).toBe(true)
    expect(cfg._skills).toEqual([
      {
        id: 'greet_user',
        meta: { name: 'greet user', description: 'Instructions for greet_user' },
      },
    ])
    expect(await readdir(join(dir, 'agents/assistant/skills/greet_user'))).toEqual(['SKILL.md'])
  })

  test('agent eval assistant greet is returned by loadEvals', async () => {
    const dir = await fresh('eval')
    await runInit(initOpts(dir, { store: 'memory' }))
    await runAgentEval({ cwd: dir, agent: 'assistant', name: 'greet' })
    const evals = await loadEvals(dir)
    expect(evals).toHaveLength(1)
    expect(evals[0].config).toMatchObject({
      agentId: 'assistant',
      type: 'functional',
      cases: [
        {
          input: 'hello',
          scorers: [{ type: 'contains', expected: 'hello' }],
        },
      ],
    })
  })

  test('ticket-lookup is a valid agent id', async () => {
    const dir = await fresh('ticket-lookup')
    await runInit(initOpts(dir, { store: 'memory' }))
    await addAgent({ cwd: dir, id: 'ticket-lookup' })
    const agents = await loadAgents(dir, ['assistant', 'ticket-lookup'])
    expect(agents.has('ticket-lookup')).toBe(true)
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toContain("'ticket-lookup'")
  })

  test('web-search is rejected as a tool name', async () => {
    const dir = await fresh('web-search')
    await runInit(initOpts(dir, { store: 'memory' }))
    await expect(runToolAdd({ cwd: dir, agent: 'assistant', name: 'web-search' })).rejects.toThrow(
      /web-search/,
    )
    expect(await exists(join(dir, 'agents/assistant/tools'))).toBe(false)
    expect(await exists(join(dir, 'agents/assistant/tools/web-search.ts'))).toBe(false)
  })

  test('Bad is rejected as an agent id', async () => {
    const dir = await fresh('bad-agent')
    await runInit(initOpts(dir, { store: 'memory' }))
    const before = await snapshot(dir)
    await expect(addAgent({ cwd: dir, id: 'Bad' })).rejects.toMatchObject({
      code: 'SCAFFOLD_INVALID_NAME',
    })
    expect(await snapshot(dir)).toEqual(before)
    expect(await exists(join(dir, 'agents/Bad'))).toBe(false)
  })

  test('a comment or string entrypoints is not edited, and a real list still is', async () => {
    const dir = await fresh('entrypoints-scan')
    await mkdir(dir)
    const commented = `const entrypoints = ['assistant']
export default {
  /** entrypoints: ['legacy'] */
  entrypoints,
}
`
    await writeFile(join(dir, 'bread.config.ts'), commented)
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(commented)
    expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)

    const line = `// entrypoints: ['assistant']\n`
    await writeFile(join(dir, 'bread.config.ts'), line)
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(line)

    const quoted = `const note = "say \\"entrypoints: ['assistant']\\""\n`
    await writeFile(join(dir, 'bread.config.ts'), quoted)
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(quoted)
    expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)

    const hyphenOnly = `export default {\n  my-entrypoints: ['assistant'],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), hyphenOnly)
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(hyphenOnly)

    const real = `export default {
  /** entrypoints: ['legacy'] */
  // entrypoints: ['assistant']
  my-entrypoints: ['legacy'],
  note: "entrypoints: ['assistant']",
  label: \`entrypoints: ['legacy']\`,
  entrypoints: ['assistant'],
}
`
    await writeFile(join(dir, 'bread.config.ts'), real)
    await addAgent({ cwd: dir, id: 'writer' })
    const after = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(after).toContain("/** entrypoints: ['legacy'] */")
    expect(after).toContain("// entrypoints: ['assistant']")
    expect(after).toContain("my-entrypoints: ['legacy']")
    expect(after).toContain(`note: "entrypoints: ['assistant']"`)
    expect(after).toContain("`entrypoints: ['legacy']`")
    expect(after).toContain("entrypoints: ['assistant', 'writer']")
    expect(after).not.toContain("'legacy', 'writer'")
  })

  test('a regexp, a $ on an identifier boundary, or a comma hole writes nothing', async () => {
    const dir = await fresh('entrypoints-unsafe')
    await mkdir(dir, { recursive: true })
    const cases = [
      `export default { re: /entrypoints: ["assistant"]/ }\n`,
      `export default { foo$entrypoints: ['assistant'] }\n`,
      `const entrypoints = ['assistant']\nexport default { entrypoints, re: /entrypoints: ['x']/ }\n`,
      `export default { entrypoints: ['assistant'], n: 1 / 2 }\n`,
      `const $schema = true\nexport default { entrypoints: ['assistant'] }\n`,
      `export default { entrypoints: ['assistant',,] }\n`,
      `export default { entrypoints: [,'assistant'] }\n`,
      `export default { entrypoints: ['assistant', , 'keeper'] }\n`,
    ]
    for (const source of cases) {
      await writeFile(join(dir, 'bread.config.ts'), source)
      await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
        code: 'ENTRYPOINTS_UNEDITABLE',
      })
      expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(source)
      expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)
    }
  })

  test('adjacent quoted strings with no comma throw before any write', async () => {
    const dir = await fresh('missing-comma')
    await mkdir(dir)
    const source = `export default {\n  entrypoints: ['echo' 'writer'],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(source)
    expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)
  })

  test('a typed entrypoints binding is not edited, and as const on the runtime array still is', async () => {
    const dir = await fresh('typed-binding')
    await mkdir(dir)
    const source = `const entrypoints: ['echo'] = ['echo']\nexport default { entrypoints }\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(source)
    expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)

    const property = `export default {\n  entrypoints: ['echo'] as const,\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), property)
    await addAgent({ cwd: dir, id: 'writer' })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(
      `export default {\n  entrypoints: ['echo', 'writer'] as const,\n}\n`,
    )
  })

  test('a type-position entrypoints list is left unchanged and nothing is written', async () => {
    const dir = await fresh('type-position')
    await mkdir(dir)
    const cases = [
      `type Config = { entrypoints: ['echo'] }\nexport default defineConfig({ entrypoints })\n`,
      `interface Config { entrypoints: ['echo'] }\nexport default defineConfig({ entrypoints })\n`,
      `interface Config<T> { entrypoints: ['echo'] }\nexport default defineConfig({ entrypoints })\n`,
      `class Box {\n  #entrypoints: ['echo']\n}\nexport default defineConfig({ entrypoints })\n`,
      `const config: { entrypoints: ['echo'] } = { entrypoints }\nexport default config\n`,
    ]
    for (const source of cases) {
      await writeFile(join(dir, 'bread.config.ts'), source)
      await expect(addAgent({ cwd: dir, id: 'writer' })).rejects.toMatchObject({
        code: 'ENTRYPOINTS_UNEDITABLE',
      })
      expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(source)
      expect(await exists(join(dir, 'agents', 'writer'))).toBe(false)
    }
  })

  test('a value entrypoints array is edited when a type alias also names one', async () => {
    const dir = await fresh('type-and-value')
    await mkdir(dir)
    const source = `type Config = { entrypoints: ['echo'] }\nexport default {\n  entrypoints: ['echo'],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await addAgent({ cwd: dir, id: 'writer' })
    const after = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(after).toContain("type Config = { entrypoints: ['echo'] }")
    expect(after).toContain("entrypoints: ['echo', 'writer']")
  })

  test('satisfies on the runtime array still appends the id', async () => {
    const dir = await fresh('satisfies-array')
    await mkdir(dir)
    const source = `export default {\n  entrypoints: ['echo'] satisfies string[],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await addAgent({ cwd: dir, id: 'writer' })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(
      `export default {\n  entrypoints: ['echo', 'writer'] satisfies string[],\n}\n`,
    )
  })

  test('a newline or carriage return before the colon edits that key, and two keys still refuse', async () => {
    const dir = await fresh('newline-colon')
    await mkdir(dir)
    const newline = `export default {\n  entrypoints\n  : ['echo'],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), newline)
    await addAgent({ cwd: dir, id: 'writer' })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toContain("entrypoints\n  : ['echo', 'writer']")

    const crlf = `export default {\r\n  entrypoints\r\n  : ['echo'],\r\n}\r\n`
    await writeFile(join(dir, 'bread.config.ts'), crlf)
    await addAgent({ cwd: dir, id: 'editor' })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toContain("'editor'")
    expect(await exists(join(dir, 'agents', 'editor', 'agent.ts'))).toBe(true)

    const two = `export default {\n  entrypoints\n  : ['echo'],\n  entrypoints: ['other'],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), two)
    await expect(addAgent({ cwd: dir, id: 'keeper' })).rejects.toMatchObject({
      code: 'ENTRYPOINTS_UNEDITABLE',
    })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(two)
    expect(await exists(join(dir, 'agents', 'keeper'))).toBe(false)
  })

  test('a single trailing comma still appends the id', async () => {
    const dir = await fresh('entrypoints-trailing')
    await mkdir(dir, { recursive: true })
    const source = `export default {\n  entrypoints: ['assistant',],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await addAgent({ cwd: dir, id: 'writer' })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(
      `export default {\n  entrypoints: ['assistant', 'writer'],\n}\n`,
    )
    expect(await exists(join(dir, 'agents', 'writer', 'agent.ts'))).toBe(true)
  })

  test('a slash or dollar inside a string or template is not code', async () => {
    const dir = await fresh('entrypoints-quoted-slash')
    await mkdir(dir, { recursive: true })
    const source = `export default {
  note: "a/b $schema",
  label: \`path/to/\${'x'}\`,
  entrypoints: ['assistant'],
}
`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await addAgent({ cwd: dir, id: 'writer' })
    const after = await readFile(join(dir, 'bread.config.ts'), 'utf8')
    expect(after).toContain(`note: "a/b $schema"`)
    expect(after).toContain("`path/to/${'x'}`")
    expect(after).toContain("entrypoints: ['assistant', 'writer']")
  })

  test('a bracket that shares the last element line keeps its indent', async () => {
    const dir = await fresh('bracket-indent')
    await mkdir(dir)
    const source = `export default {\n  entrypoints: [\n    'assistant'],\n}\n`
    await writeFile(join(dir, 'bread.config.ts'), source)
    await addAgent({ cwd: dir, id: 'writer' })
    expect(await readFile(join(dir, 'bread.config.ts'), 'utf8')).toBe(
      `export default {\n  entrypoints: [\n    'assistant',\n    'writer'],\n}\n`,
    )
  })

  test('tool, skill, and eval reject an agent id that escapes the project', async () => {
    const dir = await fresh('agent-escape')
    await runInit(initOpts(dir, { store: 'memory' }))
    const agent = '../../outside'
    const agentFile = join(dir, 'agents', agent, 'agent.ts')
    expect(relative(resolve(dir), resolve(dir, 'agents', agent)).startsWith('..')).toBe(true)
    await mkdir(join(dir, 'agents', agent), { recursive: true })
    await writeFile(agentFile, 'export default {}\n')

    await expect(runToolAdd({ cwd: dir, agent, name: 'lookup' })).rejects.toMatchObject({
      code: 'SCAFFOLD_INVALID_NAME',
    })
    expect(await exists(join(dir, 'agents', agent, 'tools', 'lookup.ts'))).toBe(false)

    await expect(runSkillAdd({ cwd: dir, agent, id: 'greet_user' })).rejects.toMatchObject({
      code: 'SCAFFOLD_INVALID_NAME',
    })
    expect(await exists(join(dir, 'agents', agent, 'skills', 'greet_user'))).toBe(false)

    const evalAgent = 'assistant/../../../tmp/evil'
    const evalAgentFile = join(dir, 'agents', evalAgent, 'agent.ts')
    expect(relative(resolve(dir), resolve(dir, 'agents', evalAgent)).startsWith('..')).toBe(true)
    await mkdir(join(dir, 'agents', evalAgent), { recursive: true })
    await writeFile(evalAgentFile, 'export default {}\n')
    await expect(runAgentEval({ cwd: dir, agent: evalAgent, name: 'greet' })).rejects.toMatchObject({
      code: 'SCAFFOLD_INVALID_NAME',
    })
    expect(await exists(join(dir, 'agents', evalAgent, 'evals', 'greet.eval.ts'))).toBe(false)

    const quotedAgent = "it's"
    await mkdir(join(dir, 'agents', quotedAgent), { recursive: true })
    await writeFile(join(dir, 'agents', quotedAgent, 'agent.ts'), 'export default {}\n')
    await expect(runAgentEval({ cwd: dir, agent: quotedAgent, name: 'greet' })).rejects.toMatchObject({
      code: 'SCAFFOLD_INVALID_NAME',
    })
    expect(await exists(join(dir, 'agents', quotedAgent, 'evals', 'greet.eval.ts'))).toBe(false)
    expect(evalSource(quotedAgent)).toContain("agentId: 'it\\'s'")
  })

  test('a skill description with a newline writes nothing', async () => {
    const dir = await fresh('skill-newline')
    await runInit(initOpts(dir, { store: 'memory' }))
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await expect(
        runSkillAdd({ cwd: dir, agent: 'assistant', id: 'greet_user', description: 'hello\nname: pwned' }),
      ).rejects.toMatchObject({ code: 'SCAFFOLD_INVALID_NAME' })
      await expect(
        runSkillAdd({ cwd: dir, agent: 'assistant', id: 'greet_user', description: 'hello\n---\nsecret' }),
      ).rejects.toMatchObject({ code: 'SCAFFOLD_INVALID_NAME' })
    } finally {
      console.log = orig
    }
    expect(logs.join('\n')).not.toContain('Added skill')
    expect(await exists(join(dir, 'agents/assistant/skills/greet_user'))).toBe(false)
    expect(() => skillSource('greet_user', 'hello\nname: pwned')).toThrow(/single line/)
  })

  test('ticket-lookup accepts tool, skill, and eval adds', async () => {
    const dir = await fresh('hyphen-agent-adds')
    await runInit(initOpts(dir, { store: 'memory' }))
    await addAgent({ cwd: dir, id: 'ticket-lookup' })
    await runToolAdd({ cwd: dir, agent: 'ticket-lookup', name: 'lookup' })
    await runSkillAdd({ cwd: dir, agent: 'ticket-lookup', id: 'greet_user', description: 'says: hello' })
    await runAgentEval({ cwd: dir, agent: 'ticket-lookup', name: 'greet' })
    expect(await exists(join(dir, 'agents/ticket-lookup/tools/lookup.ts'))).toBe(true)
    const skill = await readFile(join(dir, 'agents/ticket-lookup/skills/greet_user/SKILL.md'), 'utf8')
    expect(skill).toContain('name: greet user')
    expect(skill).toContain('description: says: hello')
    const evalText = await readFile(join(dir, 'agents/ticket-lookup/evals/greet.eval.ts'), 'utf8')
    expect(evalText).toContain("agentId: 'ticket-lookup'")
  })
})
