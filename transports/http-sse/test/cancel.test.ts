import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRegistry, BreadConfig, BreadCrumb } from '@breadai/core'
import { BreadError } from '@breadai/core'
import { startServer } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { defineTestAgent, mockChunkedTextModel, mockProvider } from '@breadai/test-utils'
import { remoteAgent, transport } from '@breadai/transport-http-sse'

// A real Bun.serve() smoke test: aborting the client-side remoteAgent().run()
// call must (a) surface as a RUN_CANCELLED BreadError locally — not a silent
// reconnect attempt — and (b) actually stop the *remote* server's underlying
// agent run, not just the local read. (b) can only be checked against the
// remote's own BreadInstance/store: relayed crumbs are tagged RELAYED and
// skipped by the crumb-log persister, so the caller's own crumb stream never
// carries the remote's terminal agent:error crumb.

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['greeter'],
    store: store(),
    transport: transport(),
    // Chunked with a real delay: several async ticks of real headroom for the
    // client's abort() call to land before the model would otherwise finish.
    providers: mockProvider({ default: mockChunkedTextModel(['a', 'b', 'c', 'd'], 30) }),
  }
  const agents: AgentRegistry = new Map([['greeter', defineTestAgent()]])
  return { config, agents }
}

async function waitForCrumbType(
  bread: Awaited<ReturnType<typeof startServer>>['bread'],
  runId: string,
  type: string,
  timeoutMs = 2000,
): Promise<BreadCrumb | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await bread.store.getCrumbs!(runId)
    const match = entries.find((e) => e.type === type)
    if (match) return match.crumb as BreadCrumb
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return undefined
}

describe('@breadai/transport-http-sse — remoteAgent() cancellation', () => {
  let stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(stops.map((s) => s()))
    stops = []
  })

  test('aborting mid-stream surfaces RUN_CANCELLED locally and stops the remote run', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)

    const controller = new AbortController()
    const it = remoteAgent({ url: `http://localhost:${port}` })
      .run('greeter', 'go', { signal: controller.signal })
      [Symbol.asyncIterator]()

    const crumbs: BreadCrumb[] = []
    let runId: string | undefined
    let thrown: unknown
    for (let i = 0; ; i++) {
      if (i === 2) controller.abort()
      let result: IteratorResult<BreadCrumb>
      try {
        result = await it.next()
      } catch (err) {
        thrown = err
        break
      }
      if (result.done) break
      crumbs.push(result.value)
      if (result.value.type === 'agent:run:start') runId = (result.value as { runId: string }).runId
    }

    expect(thrown).toBeInstanceOf(BreadError)
    expect((thrown as BreadError).code).toBe('RUN_CANCELLED')
    expect(runId).toBeDefined()

    const remoteError = await waitForCrumbType(server.bread, runId!, 'agent:error')
    expect(remoteError).toBeDefined()
    expect((remoteError as { error: { code: string } }).error.code).toBe('RUN_CANCELLED')
  })
})
