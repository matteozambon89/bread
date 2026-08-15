import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AgentRegistry, BreadConfig, BreadCrumb } from '@breadai/core'
import { BreadError, defineTool } from '@breadai/core'
import { startServer } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { defineTestAgent, mockProvider, mockToolCallModel } from '@breadai/test-utils'
import { remoteAgent, transport } from '@breadai/transport-http-sse'

// A real Bun.serve() smoke test: the server is genuinely live on a real port,
// and the client's fetch is wrapped to truncate the SSE response after N
// events — simulating a real socket read failing partway through, the same
// boundary remote-agent.ts itself observes on a real network drop. This
// exercises the actual reconnect path (GET /runs/:runId/stream with
// Last-Event-ID) end to end, not just the server's replay logic in isolation.

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const add = defineTool({
    name: 'add',
    description: 'Add two numbers',
    schema: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
  })
  const config: BreadConfig = {
    entrypoints: ['calc'],
    store: store(),
    transport: transport(),
    providers: mockProvider({
      default: mockToolCallModel({ toolName: 'tool_add', args: { a: 1, b: 2 }, then: 'done' }),
    }),
  }
  const agents: AgentRegistry = new Map([['calc', defineTestAgent({ tools: [add] })]])
  return { config, agents }
}

// Wraps `fetch` so the first `dropCount` matching SSE responses (the initial
// run POST, then any reconnect GETs) are truncated after `after` `data:`
// events — the reader then sees the stream error instead of a clean finish,
// exactly what a dropped connection looks like client-side. Non-data lines
// (id:/retry:/blank) pass through untouched up to that point.
function dropAfterEvents(res: Response, after: number): Response {
  if (!res.body) return res
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let seen = 0
  const truncated = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            if (seen === after) {
              controller.error(new Error('simulated connection drop'))
              return
            }
            seen++
          }
          controller.enqueue(encoder.encode(`${line}\n`))
        }
      },
    }),
  )
  return new Response(truncated, { status: res.status, headers: res.headers })
}

function droppingFetch(dropCount: number, after: number): typeof fetch {
  let remaining = dropCount
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init)
    const url = new URL(typeof input === 'string' ? input : String(input))
    const isRunOrReconnect =
      (init?.method === 'POST' && url.pathname.startsWith('/agents/')) || url.pathname.includes('/stream')
    if (remaining <= 0 || !isRunOrReconnect) return res
    remaining--
    return dropAfterEvents(res, after)
  }) as typeof fetch
}

describe('@breadai/transport-http-sse — remoteAgent() reconnect', () => {
  let stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(stops.map((s) => s()))
    stops = []
  })

  test('reconnects after a mid-run drop and completes with the same crumbs as an uninterrupted run', async () => {
    // Two independent servers (the mock tool-call model's script only advances
    // once per process, so a shared instance would serve the reference run's
    // *next* step to the dropped run instead of replaying the same script).
    const reference = fixture()
    const referencePort = freePort()
    const referenceServer = await startServer(reference.config, reference.agents, { port: referencePort })
    stops.push(referenceServer.stop)

    const dropped = fixture()
    const droppedPort = freePort()
    const droppedServer = await startServer(dropped.config, dropped.agents, { port: droppedPort })
    stops.push(droppedServer.stop)

    const referenceCrumbs: BreadCrumb[] = []
    for await (const crumb of remoteAgent({ url: `http://localhost:${referencePort}` }).run('calc', 'go')) {
      referenceCrumbs.push(crumb)
    }

    const crumbs: BreadCrumb[] = []
    for await (const crumb of remoteAgent({
      url: `http://localhost:${droppedPort}`,
      fetch: droppingFetch(1, 2),
      maxRetries: 3,
      retryDelayMs: 10,
    }).run('calc', 'go')) {
      crumbs.push(crumb)
    }

    expect(crumbs.at(-1)!.type).toBe('agent:run:end')
    // Same crumb count and type sequence as the uninterrupted run — the drop
    // boundary neither lost nor duplicated any crumb once reconnected.
    expect(crumbs.map((c) => c.type)).toEqual(referenceCrumbs.map((c) => c.type))
  })

  test('throws REMOTE_AGENT_RECONNECT_FAILED once retries are exhausted', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)

    const url = `http://localhost:${port}`
    const agent = remoteAgent({
      url,
      fetch: droppingFetch(Infinity, 0),
      maxRetries: 2,
      retryDelayMs: 5,
    })

    let thrown: unknown
    try {
      for await (const _crumb of agent.run('calc', 'go')) {
        // draining is enough to trigger the throw
      }
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(BreadError)
    expect((thrown as BreadError).code).toBe('REMOTE_AGENT_RECONNECT_FAILED')
    expect((thrown as BreadError).context).toMatchObject({ url, agentId: 'calc' })
  })

  test('throws immediately (not retried) on a pre-crumb failure', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)

    const url = `http://localhost:${port}`
    const agent = remoteAgent({ url, maxRetries: 3, retryDelayMs: 5 })

    const crumbs: BreadCrumb[] = []
    let thrown: unknown
    try {
      for await (const crumb of agent.run('ghost', 'go')) crumbs.push(crumb)
    } catch (err) {
      thrown = err
    }

    expect(crumbs).toHaveLength(0)
    expect(thrown).toBeInstanceOf(BreadError)
    expect((thrown as BreadError).code).toBe('AGENT_NOT_FOUND')
  })
})
