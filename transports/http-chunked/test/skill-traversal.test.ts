import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRegistry, BreadConfig, BreadCrumb } from '@bread/core'
import { store } from '@bread/store-memory'
import { defineTestAgent, mockProvider, mockTextModel } from '@bread/test-utils'
import { remoteAgent, transport } from '@bread/transport-http-chunked'
import { startServer } from '@bread/server'

// Live regression test for SEC-01: a traversal `skill` id reaching
// `POST /agents/:id/run` must not escape `agentDir/skills/` — real HTTP
// round-trip through a real Bun.serve(), not a unit call into loadSkill().

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

// Reuses the core package's existing skill fixture (skills/greet) so a
// successful, non-traversal run is provably still possible against the same
// agentDir the traversal attempt targets.
const agentDir = join(import.meta.dir, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', 'agent')

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['assistant'],
    store: store(),
    transport: transport(),
    providers: mockProvider({ default: mockTextModel('hi') }),
  }
  const agent = defineTestAgent()
  ;(agent.config as unknown as Record<string, unknown>)._agentDir = agentDir
  const agents: AgentRegistry = new Map([['assistant', agent]])
  return { config, agents }
}

describe('@bread/transport-http-chunked — skill traversal is rejected (SEC-01)', () => {
  let stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(stops.map((s) => s()))
    stops = []
  })

  test('a traversal skill id surfaces INVALID_NAME, never runs the agent', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)

    const crumbs: BreadCrumb[] = []
    for await (const crumb of remoteAgent({ url: `http://localhost:${port}` }).run('assistant', 'go', {
      skill: '../../../../etc/passwd',
    })) {
      crumbs.push(crumb)
    }

    expect(crumbs.at(-1)!.type).toBe('agent:error')
    expect((crumbs.at(-1) as { error: { code: string } }).error.code).toBe('INVALID_NAME')
    expect(crumbs.some((c) => c.type === 'text:delta')).toBe(false)
  })

  test('a valid skill id still loads normally against the same agentDir', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)

    const crumbs: BreadCrumb[] = []
    for await (const crumb of remoteAgent({ url: `http://localhost:${port}` }).run('assistant', 'go', {
      skill: 'greet',
    })) {
      crumbs.push(crumb)
    }

    expect(crumbs.at(-1)!.type).toBe('agent:run:end')
    expect(crumbs.some((c) => c.type === 'agent:error')).toBe(false)
  })
})
