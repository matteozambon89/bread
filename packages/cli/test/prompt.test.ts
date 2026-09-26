import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import { runInit, runProviderAdd } from '@breadai/server'
import { resolveScaffold, runScaffold } from '../src/init-wizard.js'
import { resolveAddNames, resolveInitChoices, type Ask, type Prompt } from '../src/prompt.js'

const provider = 'anthropic'
const model = 'claude-sonnet-4-5'

const defaults = {
  runtime: 'bun',
  store: 'sqlite',
  transport: 'chunked',
  agent: 'assistant',
  install: true,
  provider,
  model,
}

const QUESTION_ORDER = ['runtime', 'store', 'transport', 'agent', 'install', 'provider', 'model'] as const

function scripted(answers: readonly unknown[]): { ask: Ask; prompts: Prompt[] } {
  const prompts: Prompt[] = []
  let index = 0
  return {
    prompts,
    ask(prompt) {
      prompts.push(prompt)
      if (index >= answers.length) throw new Error(`no answer for ${prompt.name}`)
      const answer = answers[index]
      index += 1
      return answer
    },
  }
}

function askCounter(): { ask: Ask; calls: () => number } {
  let calls = 0
  return {
    ask: () => {
      calls++
      return 'asked'
    },
    calls: () => calls,
  }
}

function optionValues(prompt: Prompt | undefined): string[] {
  if (prompt?.kind !== 'select') throw new Error(`expected a select, got ${prompt?.kind}`)
  return prompt.options.map((option) => option.value)
}

describe('resolveInitChoices', () => {
  test('on a TTY the first question is the runtime', async () => {
    const script = scripted(['bun', 'sqlite', 'chunked', 'assistant', true, provider, model])
    await resolveInitChoices({}, true, script.ask)
    expect(script.prompts[0]).toMatchObject({ kind: 'select', name: 'runtime', initialValue: 'bun' })
    expect(optionValues(script.prompts[0])).toEqual(['bun', 'node'])
  })

  test('answering node makes the store question offer memory and postgres, default memory', async () => {
    const answered = scripted(['node', '', 'chunked', 'assistant', true, provider, model])
    const choices = await resolveInitChoices({}, true, answered.ask)
    expect(answered.prompts[0]?.name).toBe('runtime')
    const store = answered.prompts[1]
    expect(store).toMatchObject({ kind: 'select', name: 'store', initialValue: 'memory' })
    expect(optionValues(store)).toEqual(['memory', 'postgres'])
    expect(choices.runtime).toBe('node')
    expect(choices.store).toBe('memory')

    const flagged = scripted(['', 'chunked', 'assistant', true, provider, model])
    await resolveInitChoices({ runtime: 'node' }, true, flagged.ask)
    expect(flagged.prompts[0]).toMatchObject({ kind: 'select', name: 'store', initialValue: 'memory' })
    expect(optionValues(flagged.prompts[0])).toEqual(['memory', 'postgres'])
  })

  test('omitted flags call ask in order and the answers become the choices', async () => {
    const script = scripted(['node', 'postgres', 'sse', 'writer', false, provider, model])
    const choices = await resolveInitChoices({}, true, script.ask)
    expect(script.prompts.map((prompt) => prompt.name)).toEqual([...QUESTION_ORDER])
    expect(choices).toEqual({
      runtime: 'node',
      store: 'postgres',
      transport: 'sse',
      agent: 'writer',
      install: false,
      provider,
      model,
    })
  })

  test('a passed flag is not asked', async () => {
    const script = scripted([])
    const choices = await resolveInitChoices(
      {
        runtime: 'bun',
        store: 'sqlite',
        transport: 'chunked',
        agent: 'assistant',
        install: false,
        provider,
        model,
      },
      true,
      script.ask,
    )
    expect(script.prompts).toEqual([])
    expect(choices).toEqual({ ...defaults, install: false })

    const partial = scripted(['sse', 'writer', true, provider, model])
    const partialChoices = await resolveInitChoices({ runtime: 'node', store: 'memory' }, true, partial.ask)
    expect(partial.prompts.map((prompt) => prompt.name)).toEqual(['transport', 'agent', 'install', 'provider', 'model'])
    expect(partialChoices).toEqual({
      runtime: 'node',
      store: 'memory',
      transport: 'sse',
      agent: 'writer',
      install: true,
      provider,
      model,
    })
  })

  test('an empty answer keeps the default for runtime, store, transport, agent, and install', async () => {
    const script = scripted(['', '', '', '', '', provider, model])
    const choices = await resolveInitChoices({}, true, script.ask)
    expect(script.prompts.map((prompt) => prompt.name)).toEqual([...QUESTION_ORDER])
    expect(choices).toEqual(defaults)
  })

  test('a blank provider or model is asked again and is not a skip', async () => {
    const script = scripted(['bun', 'sqlite', 'chunked', 'assistant', true, '', '  ', provider, '', model])
    const choices = await resolveInitChoices({}, true, script.ask)
    expect(script.prompts.map((prompt) => prompt.name)).toEqual([
      'runtime',
      'store',
      'transport',
      'agent',
      'install',
      'provider',
      'provider',
      'provider',
      'model',
      'model',
    ])
    const providerPrompt = script.prompts.find((prompt) => prompt.name === 'provider')
    const modelPrompt = script.prompts.find((prompt) => prompt.name === 'model')
    expect(providerPrompt).toMatchObject({ kind: 'text', message: 'Catalog provider' })
    expect(modelPrompt).toMatchObject({ kind: 'text', message: 'Model id' })
    expect(providerPrompt && 'initialValue' in providerPrompt ? providerPrompt.initialValue : undefined).toBeUndefined()
    expect(modelPrompt && 'placeholder' in modelPrompt ? modelPrompt.placeholder : undefined).toBeUndefined()
    expect(choices.provider).toBe(provider)
    expect(choices.model).toBe(model)
  })

  test('an invalid agent id is asked again', async () => {
    const script = scripted(['bun', 'sqlite', 'chunked', 'Bad', '', true, provider, model])
    const choices = await resolveInitChoices({}, true, script.ask)
    const agentPrompts = script.prompts.filter((prompt) => prompt.name === 'agent')
    expect(agentPrompts).toHaveLength(2)
    expect(agentPrompts[0]).toMatchObject({ kind: 'text', initialValue: 'assistant' })
    expect(choices.agent).toBe('assistant')
  })

  test('a non-TTY uses defaults and still requires provider and model without asking', async () => {
    const counter = askCounter()
    expect(await resolveInitChoices({ provider, model }, false, counter.ask)).toEqual(defaults)
    expect(
      await resolveInitChoices(
        { runtime: 'node', install: false, provider: 'openai', model: 'gpt-4o' },
        false,
        counter.ask,
      ),
    ).toEqual({
      ...defaults,
      runtime: 'node',
      store: 'memory',
      install: false,
      provider: 'openai',
      model: 'gpt-4o',
    })
    await expect(resolveInitChoices({}, false, counter.ask)).rejects.toThrow(/--provider/)
    await expect(resolveInitChoices({ provider }, false, counter.ask)).rejects.toThrow(/--model/)
    expect(counter.calls()).toBe(0)
  })
})

describe('resolveAddNames', () => {
  test('agent add on a TTY asks for a missing id, then provider and model, and a blank answer is asked again', async () => {
    const script = scripted(['writer', '', provider, ' ', model])
    const names = await resolveAddNames({ kind: 'agent' }, true, script.ask)
    expect(script.prompts.map((prompt) => prompt.name)).toEqual(['id', 'provider', 'provider', 'model', 'model'])
    expect(names).toEqual({ id: 'writer', provider, model })
  })

  test('tool, skill, and eval do not ask for a provider or model', async () => {
    const tool = scripted(['assistant', 'lookup'])
    expect(await resolveAddNames({ kind: 'tool' }, true, tool.ask)).toEqual({ agent: 'assistant', name: 'lookup' })
    expect(tool.prompts.map((prompt) => prompt.name)).toEqual(['agent', 'name'])
    const skill = scripted(['assistant', 'greet'])
    expect(await resolveAddNames({ kind: 'skill' }, true, skill.ask)).toEqual({ agent: 'assistant', id: 'greet' })
    const evalNames = scripted(['assistant', 'says_hello'])
    expect(await resolveAddNames({ kind: 'eval' }, true, evalNames.ask)).toEqual({
      agent: 'assistant',
      name: 'says_hello',
    })
  })

  test('without a TTY a missing id, provider, or model throws before ask', async () => {
    const counter = askCounter()
    await expect(resolveAddNames({ kind: 'agent' }, false, counter.ask)).rejects.toThrow(/id/)
    await expect(resolveAddNames({ kind: 'agent', id: 'writer' }, false, counter.ask)).rejects.toThrow(/--provider/)
    await expect(resolveAddNames({ kind: 'agent', id: 'writer', provider }, false, counter.ask)).rejects.toThrow(
      /--model/,
    )
    await expect(resolveAddNames({ kind: 'tool', name: 'lookup' }, false, counter.ask)).rejects.toThrow(/agent/)
    expect(
      await resolveAddNames({ kind: 'agent', id: 'writer', provider, model }, false, counter.ask),
    ).toEqual({ id: 'writer', provider, model })
    expect(counter.calls()).toBe(0)
  })
})

function outputStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

const wizardChoices = {
  runtime: 'bun' as const,
  store: 'memory' as const,
  transport: 'chunked' as const,
  agent: 'assistant',
  install: true,
  provider: 'ollama',
  model: 'llama3.2',
}

describe('resolveScaffold', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('an existing bread.config.ts, package.json, or agents throws SCAFFOLD_EXISTS before the first question', async () => {
    for (const marker of ['bread.config.ts', 'package.json', 'agents'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'bread-init-exists-'))
      dirs.push(dir)
      if (marker === 'agents') mkdirSync(join(dir, marker))
      else writeFileSync(join(dir, marker), 'keep\n')
      const counter = askCounter()
      const root = resolve(dir)
      let caught: unknown
      try {
        await resolveScaffold(root, {}, true, counter.ask)
      } catch (err) {
        caught = err
      }
      expect(counter.calls()).toBe(0)
      expect(caught).toBeInstanceOf(BreadError)
      const error = caught as BreadError
      expect(error.code).toBe('SCAFFOLD_EXISTS')
      expect(error.message).toBe(
        `Refusing to init ${root}: ${marker} already exists. Nothing was written.`,
      )
      await expect(
        runInit({
          dir: root,
          runtime: 'bun',
          store: 'memory',
          transport: 'chunked',
          agent: 'assistant',
          provider,
          model,
          noInstall: true,
        }),
      ).rejects.toMatchObject({ code: 'SCAFFOLD_EXISTS', message: error.message })
    }

    const empty = mkdtempSync(join(tmpdir(), 'bread-init-flags-'))
    dirs.push(empty)
    const counter = askCounter()
    const choices = await resolveScaffold(
      empty,
      {
        runtime: 'bun',
        store: 'memory',
        transport: 'chunked',
        agent: 'assistant',
        install: false,
        provider,
        model,
      },
      true,
      counter.ask,
    )
    expect(counter.calls()).toBe(0)
    expect(choices).toEqual({ ...defaults, store: 'memory', install: false })
  })
})

describe('runScaffold status', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('install and provider add print a status line and do not start a spinner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(dir)
    const calls: Array<{ cmd: unknown; stdout?: unknown; stderr?: unknown }> = []
    const logs: string[] = []
    const stdout: string[] = []
    const originalSpawn = Bun.spawn
    const originalLog = console.log
    const originalWrite = process.stdout.write
    Bun.spawn = ((cmd: unknown, opts?: { stdout?: unknown; stderr?: unknown }) => {
      calls.push({ cmd, stdout: opts?.stdout, stderr: opts?.stderr })
      return { exited: Promise.resolve(0), stdout: outputStream('bun-out\n'), stderr: outputStream('') }
    }) as typeof Bun.spawn
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await runScaffold(dir, wizardChoices, true)
    } finally {
      Bun.spawn = originalSpawn
      console.log = originalLog
      process.stdout.write = originalWrite
    }
    const text = stdout.join('')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const call of calls) {
      expect(call.stdout).toBe('pipe')
      expect(call.stderr).toBe('pipe')
    }
    expect(logs.filter((line) => line.includes('[bread]'))).toEqual([])
    expect(stdout).toContain('Installing dependencies\n')
    expect(stdout).toContain('Adding ollama\n')
    expect(text.indexOf('Installing dependencies\n')).toBeLessThan(text.indexOf('bun-out\n'))
    expect(text).not.toContain('anthropic')
    expect(text).not.toContain('bread provider add')
    expect(readFileSync(new URL('../src/clack.ts', import.meta.url), 'utf8')).not.toMatch(/\bspinner\b/)
  })

  test('--no-install prints bread provider add for the chosen provider and does not install it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(dir)
    const calls: unknown[] = []
    const stdout: string[] = []
    const originalSpawn = Bun.spawn
    const originalWrite = process.stdout.write
    Bun.spawn = ((cmd: unknown) => {
      calls.push(cmd)
      return { exited: Promise.resolve(0), stdout: outputStream(''), stderr: outputStream('') }
    }) as typeof Bun.spawn
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await runScaffold(dir, { ...wizardChoices, install: false }, true)
    } finally {
      Bun.spawn = originalSpawn
      process.stdout.write = originalWrite
    }
    expect(calls).toEqual([])
    const text = stdout.join('')
    expect(text).toContain('bread provider add ollama')
    expect(text).not.toContain('anthropic')
  })

  test('without a TTY, install still adds the chosen provider and --no-install only prints the command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(dir)
    const calls: unknown[] = []
    const logs: string[] = []
    const originalSpawn = Bun.spawn
    const originalLog = console.log
    Bun.spawn = ((cmd: unknown) => {
      calls.push(cmd)
      return { exited: Promise.resolve(0), stdout: outputStream(''), stderr: outputStream('') }
    }) as typeof Bun.spawn
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await runScaffold(dir, wizardChoices, false)
    } finally {
      Bun.spawn = originalSpawn
      console.log = originalLog
    }
    expect(calls).toEqual([
      ['bun', 'install'],
      ['bun', 'add', 'ollama-ai-provider-v2'],
    ])
    const text = logs.join('\n')
    expect(text).toContain('bread dev')
    expect(text).not.toContain('bread provider add')
    expect(text).not.toContain('anthropic')

    calls.length = 0
    logs.length = 0
    const skipped = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(skipped)
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }
    try {
      await runScaffold(skipped, { ...wizardChoices, install: false }, false)
    } finally {
      console.log = originalLog
    }
    expect(calls).toEqual([])
    const skippedText = logs.join('\n')
    expect(skippedText).toContain('bread provider add ollama')
    expect(skippedText).not.toContain('anthropic')
  })

  test('a failed catalog install says the files were written and keeps the bun add error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(dir)
    const originalSpawn = Bun.spawn
    Bun.spawn = ((cmd: unknown) => {
      const args = cmd as string[]
      const code = args[1] === 'add' ? 1 : 0
      return { exited: Promise.resolve(code), stdout: outputStream(''), stderr: outputStream('') }
    }) as typeof Bun.spawn
    let caught: unknown
    try {
      await runScaffold(dir, wizardChoices, false)
    } catch (err) {
      caught = err
    } finally {
      Bun.spawn = originalSpawn
    }
    expect(caught).toBeInstanceOf(BreadError)
    const error = caught as BreadError
    expect(error.message).toContain('Project files were already written')
    expect(error.message).toContain('A second bread init will refuse with SCAFFOLD_EXISTS')
    expect(error.message).toContain('`bun add ollama-ai-provider-v2` failed (exit 1)')
    expect(existsSync(join(dir, 'bread.config.ts'))).toBe(true)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'agents'))).toBe(true)

    const project = mkdtempSync(join(tmpdir(), 'bread-provider-'))
    dirs.push(project)
    writeFileSync(join(project, 'package.json'), '{"name":"keep"}\n')
    Bun.spawn = (() => ({
      exited: Promise.resolve(1),
      stdout: outputStream(''),
      stderr: outputStream(''),
    })) as typeof Bun.spawn
    let generic: unknown
    try {
      await runProviderAdd({ cwd: project, name: 'ollama' })
    } catch (err) {
      generic = err
    } finally {
      Bun.spawn = originalSpawn
    }
    expect(generic).toBeInstanceOf(BreadError)
    const providerError = generic as BreadError
    expect(providerError.code).toBe('PROVIDER_INSTALL_FAILED')
    expect(providerError.message).toBe('`bun add ollama-ai-provider-v2` failed (exit 1)')
    expect(providerError.message).not.toContain('SCAFFOLD_EXISTS')
  })

  test('constructor throws before the wizard writes or spawns bun add', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(dir)
    const calls: unknown[] = []
    const originalSpawn = Bun.spawn
    Bun.spawn = ((cmd: unknown) => {
      calls.push(cmd)
      return { exited: Promise.resolve(0), stdout: outputStream(''), stderr: outputStream('') }
    }) as typeof Bun.spawn
    try {
      await expect(runScaffold(dir, { ...wizardChoices, provider: 'constructor' }, false)).rejects.toMatchObject({
        code: 'UNKNOWN_PROVIDER',
      })
    } finally {
      Bun.spawn = originalSpawn
    }
    expect(calls).toEqual([])
    expect(existsSync(join(dir, 'package.json'))).toBe(false)
    expect(existsSync(join(dir, 'bread.config.ts'))).toBe(false)
    expect(existsSync(join(dir, 'agents'))).toBe(false)
  })

  test('SIGINT during install kills the child and exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bread-wizard-'))
    dirs.push(dir)
    let killed: string | undefined
    const originalSpawn = Bun.spawn
    const originalExit = process.exit
    const originalWrite = process.stdout.write
    const before = new Set(process.listeners('SIGINT'))
    let spawned!: () => void
    const spawnedPromise = new Promise<void>((resolve) => {
      spawned = resolve
    })
    Bun.spawn = (() => {
      spawned()
      return {
        exited: new Promise<number>(() => {}),
        stdout: outputStream(''),
        stderr: outputStream(''),
        kill(signal: string) {
          killed = signal
        },
      }
    }) as unknown as typeof Bun.spawn
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as typeof process.exit
    process.stdout.write = (() => true) as typeof process.stdout.write
    let caught: unknown
    try {
      const pending = runScaffold(dir, wizardChoices, true)
      pending.catch(() => {})
      await spawnedPromise
      const added = process.listeners('SIGINT').filter((listener) => !before.has(listener))
      expect(added).toHaveLength(1)
      added[0]!()
    } catch (error) {
      caught = error
    } finally {
      process.exit = originalExit
      process.stdout.write = originalWrite
      for (const listener of process.listeners('SIGINT')) {
        if (!before.has(listener)) process.off('SIGINT', listener)
      }
      Bun.spawn = originalSpawn
    }
    expect(killed).toBe('SIGINT')
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('exit:130')
  })
})
