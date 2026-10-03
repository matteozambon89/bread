import { describe, expect, test } from 'bun:test'
import { resolveAddNames, resolveInitChoices, type Ask } from '../src/prompt.js'

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

describe('resolveInitChoices', () => {
  test('a non-TTY uses defaults for runtime, store, transport, agent, and install, and still requires provider and model', () => {
    const counter = askCounter()
    expect(resolveInitChoices({ provider, model }, false, counter.ask)).toEqual(defaults)
    expect(
      resolveInitChoices({ runtime: 'node', install: false, provider: 'openai', model: 'gpt-4o' }, false, counter.ask),
    ).toEqual({
      ...defaults,
      runtime: 'node',
      store: 'memory',
      install: false,
      provider: 'openai',
      model: 'gpt-4o',
    })
    expect(() => resolveInitChoices({}, false, counter.ask)).toThrow(/--provider/)
    expect(() => resolveInitChoices({ provider }, false, counter.ask)).toThrow(/--model/)
    expect(counter.calls()).toBe(0)
  })

  test('a TTY with a missing choice throws, names the flag, and does not call ask', () => {
    const counter = askCounter()
    expect(() => resolveInitChoices({ provider, model }, true, counter.ask)).toThrow(/--runtime/)
    expect(() =>
      resolveInitChoices(
        { runtime: 'bun', store: 'sqlite', transport: 'chunked', provider, model },
        true,
        counter.ask,
      ),
    ).toThrow(/--agent/)
    expect(() =>
      resolveInitChoices(
        { runtime: 'bun', store: 'sqlite', transport: 'chunked', agent: 'assistant', model },
        true,
        counter.ask,
      ),
    ).toThrow(/--provider/)
    expect(() =>
      resolveInitChoices(
        { runtime: 'bun', store: 'sqlite', transport: 'chunked', agent: 'assistant', provider },
        true,
        counter.ask,
      ),
    ).toThrow(/--model/)
    expect(
      resolveInitChoices(
        { runtime: 'bun', store: 'sqlite', transport: 'chunked', agent: 'assistant', provider, model },
        true,
        counter.ask,
      ),
    ).toEqual(defaults)
    expect(counter.calls()).toBe(0)
  })
})

describe('resolveAddNames', () => {
  test('agent add without an id, provider, or model throws and does not call ask', () => {
    const counter = askCounter()
    expect(() => resolveAddNames({ kind: 'agent' }, true, counter.ask)).toThrow(/id/)
    expect(() => resolveAddNames({ kind: 'agent' }, false, counter.ask)).toThrow(/id/)
    expect(() => resolveAddNames({ kind: 'agent', id: 'writer' }, false, counter.ask)).toThrow(/--provider/)
    expect(() => resolveAddNames({ kind: 'agent', id: 'writer', provider }, true, counter.ask)).toThrow(/--model/)
    expect(resolveAddNames({ kind: 'agent', id: 'writer', provider, model }, false, counter.ask)).toEqual({
      id: 'writer',
      provider,
      model,
    })
    expect(() => resolveAddNames({ kind: 'tool', name: 'lookup' }, false, counter.ask)).toThrow(/agent/)
    expect(counter.calls()).toBe(0)
  })
})
