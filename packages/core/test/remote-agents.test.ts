import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadCrumb, BreadInstance, RemoteAgent } from '@bread/core'
import { store as sqliteStore } from '@bread/store-sqlite'
import { collect, defineTestAgent, makeBread, mockTextModel, stream } from '@bread/test-utils'

describe('runner — remote agents', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>
  let seen: string[]

  // A fake remote agent: records the dispatch and replays a fixed crumb stream, standing
  // in for a transport's `remoteAgent(...)` without any network. `remoteFoo` is
  // intentionally NOT in the local registry — remote dispatch must not require a
  // local agent.
  function fakeRemote(): RemoteAgent {
    return {
      async *run(agentId, input) {
        seen.push(`${agentId}:${String(input)}`)
        yield { type: 'text:delta', agentId, runId: 'r', sessionId: 's', timestamp: 0, delta: 'hi' } as BreadCrumb
        yield {
          type: 'agent:run:end',
          agentId,
          runId: 'r',
          sessionId: 's',
          timestamp: 0,
          output: 'remote-output',
        } as BreadCrumb
      },
    }
  }

  beforeEach(async () => {
    seen = []
    ;({ bread, stop } = await makeBread({
      agents: { local: defineTestAgent({}) },
      model: mockTextModel('unused'),
      config: { remoteAgents: { remoteFoo: fakeRemote() } },
    }))
  })

  afterEach(() => stop())

  test('bread.run dispatches a remote agent and relays its crumb stream', async () => {
    const crumbs = await collect(stream(bread, 'remoteFoo', 'task'))
    expect(seen).toEqual(['remoteFoo:task'])
    expect(crumbs.map((c) => c.type)).toEqual(['text:delta', 'agent:run:end'])
  })

  test('relayed crumbs are re-emitted on the local bus for observers', async () => {
    const observed: string[] = []
    bread.on('crumb', (c) => observed.push((c as BreadCrumb).type))
    await collect(stream(bread, 'remoteFoo', 'task'))
    expect(observed).toEqual(['text:delta', 'agent:run:end'])
  })
})

describe('runner — remote agent crumb persistence', () => {
  // A real, FK-enforcing store (unlike @bread/store-memory, the harness
  // default): crumbs.session_id references sessions(id), so this reproduces
  // what a real RemoteAgent.run() relay looks like — crumbs stamped with a
  // sessionId that only exists on the remote replica, never created locally.
  function fakeRemote(): RemoteAgent {
    return {
      async *run(agentId, input) {
        yield {
          type: 'text:delta',
          agentId,
          runId: 'remote-run',
          sessionId: 'remote-session',
          timestamp: 0,
          delta: String(input),
        } as BreadCrumb
        yield {
          type: 'agent:run:end',
          agentId,
          runId: 'remote-run',
          sessionId: 'remote-session',
          timestamp: 0,
          output: 'remote-output',
        } as BreadCrumb
      },
    }
  }

  test('relaying against a persistent store never hits the session FK and never disables crumb logging', async () => {
    const { bread, stop } = await makeBread({
      agents: { local: defineTestAgent({}) },
      model: mockTextModel('unused'),
      config: { store: sqliteStore(), remoteAgents: { remoteFoo: fakeRemote() } },
    })

    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const crumbs = await collect(stream(bread, 'remoteFoo', 'task'))
      expect(crumbs.map((c) => c.type)).toEqual(['text:delta', 'agent:run:end'])
      expect(warnings).toEqual([])
      // 'remote-session' was never created locally — the relayed run's
      // crumbs are observable in the stream above but must not be durably
      // persisted.
      expect(await bread.store.getCrumbs!('remote-run')).toEqual([])
    } finally {
      console.warn = originalWarn
      await stop()
    }
  })
})

describe('runner — remote agent lifecycle', () => {
  test('bread.start awaits init and bread.stop awaits close on every remote agent', async () => {
    const calls: string[] = []
    const withLifecycle: RemoteAgent = {
      async *run() {
        // never dispatched in this test
      },
      init: async () => void calls.push('init'),
      close: async () => void calls.push('close'),
    }
    const { bread, stop } = await makeBread({
      agents: { local: defineTestAgent({}) },
      model: mockTextModel('unused'),
      config: { remoteAgents: { r: withLifecycle } },
    })
    expect(calls).toEqual(['init'])
    await collect(stream(bread, 'local', 'x')) // lifecycle-less runs still work
    await stop()
    expect(calls).toEqual(['init', 'close'])
  })
})
