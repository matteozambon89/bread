import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRegistry, BreadConfig, SpeechModel } from '@breadai/core'
import { startServer } from '@breadai/runtime-bun'
import { store } from '@breadai/store-memory'
import { defineTestAgent, memoryBlobStore, mockProvider, mockTextModel } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-chunked'

const AUDIO = new Uint8Array([9, 8, 7])

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fakeSpeech(): SpeechModel {
  return {
    specificationVersion: 'v4',
    provider: 'fake.speech',
    modelId: 'tts-1',
    async doGenerate() {
      return {
        audio: AUDIO,
        warnings: [],
        response: {
          timestamp: new Date(),
          modelId: 'tts-1',
          headers: { 'content-type': 'audio/mpeg' },
        },
      }
    },
  } as SpeechModel
}

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['assistant'],
    store: store(),
    transport: transport(),
    providers: mockProvider({ default: mockTextModel('unused') }),
    blobStore: memoryBlobStore(),
    speech: { openai: () => fakeSpeech() },
    pipelines: {
      speak: [{ type: 'speech', provider: 'openai', model: 'tts-1' }],
    },
  }
  const agents: AgentRegistry = new Map([['assistant', defineTestAgent()]])
  return { config, agents }
}

function speechRunId(body: string): string {
  for (const line of body.split('\n')) {
    if (!line.includes('file:generated')) continue
    const frame = JSON.parse(line) as { crumb?: { type?: string; runId?: string } }
    if (frame.crumb?.type === 'file:generated' && frame.crumb.runId) return frame.crumb.runId
  }
  throw new Error(`no file:generated crumb in pipeline stream: ${body.slice(0, 500)}`)
}

describe('GET /runs/:runId/stream — speech step', () => {
  let stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(stops.map((stop) => stop()))
    stops = []
  })

  test('a finished speech step replays the file and then the stream ends', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)
    const url = `http://localhost:${port}`

    const run = await fetch(`${url}/pipelines/speak/run`, {
      method: 'POST',
      body: JSON.stringify({ input: 'ord-1002, charged twice' }),
    })
    expect(run.status).toBe(200)
    const runId = speechRunId(await run.text())

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 800)
    let body = ''
    let ended = false
    try {
      const res = await fetch(`${url}/runs/${encodeURIComponent(runId)}/stream`, { signal: ac.signal })
      expect(res.status).toBe(200)
      body = await res.text()
      ended = true
    } catch {
      ended = false
    } finally {
      clearTimeout(timer)
    }

    expect(ended).toBe(true)
    const fileAt = body.indexOf('file:generated')
    const endAt = body.indexOf('agent:run:end')
    expect(fileAt).toBeGreaterThanOrEqual(0)
    expect(endAt).toBeGreaterThan(fileAt)
  })
})
