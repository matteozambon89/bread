import { describe, expect, test } from 'bun:test'
import type { SpeechModel } from 'ai'
import { z } from 'zod'
import {
  BreadError,
  defineHumanTool,
  isFileOutput,
  LOCAL_CLI_PRINCIPAL,
  runVisible,
  type AgentRunStartCrumb,
  type BlobStore,
  type BreadCrumb,
  type FileGeneratedCrumb,
  type PipelineStepEndCrumb,
  type PipelineStepStartCrumb,
  type SpeechRegistry,
} from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  memoryBlobStore,
  mockErrorModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  type ScriptStep,
} from '@breadai/test-utils'
import type { MockLanguageModelV4 } from 'ai/test'

const TICKET = 'ord-1002, charged twice'
const AUDIO = new Uint8Array([9, 8, 7])

function fakeSpeech(seen: { text?: string; calls: number }): SpeechModel {
  return {
    specificationVersion: 'v4',
    provider: 'fake.speech',
    modelId: 'tts-1',
    async doGenerate(options) {
      seen.calls += 1
      seen.text = options.text
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

function speechRegistry(seen: { text?: string; calls: number }): SpeechRegistry {
  return { openai: () => fakeSpeech(seen) }
}

const decision = {
  type: 'decision' as const,
  provider: 'typesafe',
  model: 'jev-latest',
  question: {
    type: 'choice' as const,
    text: 'How should this refund be routed?',
    options: ['needs_review', 'auto_refund', 'deny'],
    otherwise: 'needs_review',
  },
}

async function drain(gen: AsyncIterable<BreadCrumb>): Promise<{ crumbs: BreadCrumb[]; error?: unknown }> {
  const crumbs: BreadCrumb[] = []
  try {
    for await (const crumb of gen) crumbs.push(crumb)
    return { crumbs }
  } catch (error) {
    return { crumbs, error }
  }
}

describe('bread.runPipeline — speech step', () => {
  test('stores the audio, emits file:generated then agent:run:end, and passes the file on', async () => {
    const seen = { calls: 0 }
    const blobs = memoryBlobStore()
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const principal = { iss: 'https://idp.example', sub: 'ada' }
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        blobStore: blobs,
        speech: speechRegistry(seen),
        decisions: {
          typesafe: async () => ({
            async systemOne() {
              return { answers: [{ type: 'choice', choice: 'auto_refund', confidence: 0.9 }] }
            },
          }),
        },
        pipelines: {
          speak: [decision, { type: 'speech', provider: 'openai', model: 'tts-1' }, { type: 'agent', agentId: 'reply' }],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('speak', TICKET, { principal }))
      expect(seen.text).toBe(TICKET)
      expect(seen.calls).toBe(1)
      const fileCrumb = crumbs.find((crumb) => crumb.type === 'file:generated') as FileGeneratedCrumb
      expect(fileCrumb.agentId).toBe('speech')
      expect(fileCrumb.mimeType.length).toBeGreaterThan(0)
      expect(fileCrumb.principal).toEqual(principal)
      expect(fileCrumb.sessionId).toBeUndefined()
      const logged = await bread.store.getCrumbs!(fileCrumb.runId)
      expect(logged.map((entry) => entry.type)).toEqual(['file:generated', 'agent:run:end'])
      expect(logged[0]?.sessionId ?? null).toBeNull()
      expect((logged[0]?.crumb as { principal?: typeof principal }).principal).toEqual(principal)
      expect(await runVisible(bread.store, fileCrumb.runId, principal)).toBe(true)
      expect(await runVisible(bread.store, fileCrumb.runId, { iss: principal.iss, sub: 'other' })).toBe(false)
      const key = fileCrumb.uri.slice('memory://'.length)
      const stored = await blobs.get(key)
      expect([...(stored?.data ?? [])]).toEqual([9, 8, 7])
      expect(stored?.mimeType).toBe(fileCrumb.mimeType)
      const end = crumbs.find((crumb) => crumb.type === 'pipeline:step:end' && crumb.agentId === 'speech') as PipelineStepEndCrumb
      expect(isFileOutput(end.output)).toBe(true)
      expect(end.output).toEqual({ kind: 'file', uri: fileCrumb.uri, mimeType: fileCrumb.mimeType })
      const prompt = JSON.stringify(reply.doStreamCalls[0]!.prompt)
      expect(prompt).toContain(fileCrumb.uri)
      expect(prompt).toContain('\\"kind\\":\\"file\\"')
      expect(prompt).not.toContain('auto_refund')
    } finally {
      await stop()
    }
  })

  test('keeps the audio on the speech step run id after an agent step', async () => {
    const seen = { calls: 0 }
    const principal = { iss: 'https://idp.example', sub: 'ada' }
    const { bread, stop } = await makeBread({
      agents: { lookup: defineTestAgent({ model: 'lookup' }) },
      models: { lookup: mockTextModel(TICKET) },
      config: {
        blobStore: memoryBlobStore(),
        speech: speechRegistry(seen),
        pipelines: {
          speak: [
            { type: 'agent', agentId: 'lookup' },
            { type: 'speech', provider: 'openai', model: 'tts-1' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('speak', 'lookup this', { principal }))
      const agentStart = crumbs.find((crumb) => crumb.type === 'agent:run:start') as AgentRunStartCrumb
      const stepStart = crumbs.find(
        (crumb) => crumb.type === 'pipeline:step:start' && crumb.agentId === 'speech',
      ) as PipelineStepStartCrumb
      const fileCrumb = crumbs.find((crumb) => crumb.type === 'file:generated') as FileGeneratedCrumb
      expect(fileCrumb.runId).toBe(stepStart.runId)
      expect(fileCrumb.runId).not.toBe(agentStart.runId)
      expect(crumbs.some((crumb) => crumb.runId === fileCrumb.runId && crumb.type === 'agent:run:start')).toBe(false)
      const logged = await bread.store.getCrumbs!(fileCrumb.runId)
      expect(logged.map((entry) => entry.type)).toEqual(['file:generated', 'agent:run:end'])
      expect(logged[0]?.seq).toBe(fileCrumb.seq)
      const agentLogged = await bread.store.getCrumbs!(agentStart.runId)
      expect(agentLogged.some((entry) => entry.type === 'file:generated')).toBe(false)
      expect(await runVisible(bread.store, fileCrumb.runId, principal)).toBe(true)
      expect(await runVisible(bread.store, fileCrumb.runId, LOCAL_CLI_PRINCIPAL)).toBe(false)
    } finally {
      await stop()
    }
  })

  test('an unstamped speech run stays visible to the local cli principal only', async () => {
    const seen = { calls: 0 }
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        speech: speechRegistry(seen),
        pipelines: { speak: [{ type: 'speech', provider: 'openai', model: 'tts-1' }] },
      },
    })
    try {
      const before = await bread.store.listSessions()
      const crumbs = await collect(bread.runPipeline('speak', TICKET))
      const fileCrumb = crumbs.find((crumb) => crumb.type === 'file:generated') as FileGeneratedCrumb
      expect(await bread.store.listSessions()).toEqual(before)
      expect(fileCrumb.principal).toBeUndefined()
      expect(await runVisible(bread.store, fileCrumb.runId, LOCAL_CLI_PRINCIPAL)).toBe(true)
      expect(await runVisible(bread.store, fileCrumb.runId, { iss: 'https://idp.example', sub: 'ada' })).toBe(false)
    } finally {
      await stop()
    }
  })

  test('throws SPEECH_INPUT before calling the speech model when the value is not a string', async () => {
    const seen = { calls: 0 }
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        blobStore: memoryBlobStore(),
        speech: speechRegistry(seen),
        pipelines: { speak: [{ type: 'speech', provider: 'openai', model: 'tts-1' }] },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('speak', { ticket: TICKET }))
      expect((error as BreadError).code).toBe('SPEECH_INPUT')
      expect(seen.calls).toBe(0)
      expect(crumbs.some((crumb) => crumb.type === 'file:generated')).toBe(false)
      expect(crumbs.some((crumb) => crumb.type === 'pipeline:step:end')).toBe(false)
    } finally {
      await stop()
    }
  })

  test('throws BLOB_STORE_NOT_CONFIGURED before resolving a speech model', async () => {
    const seen = { calls: 0 }
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        speech: speechRegistry(seen),
        pipelines: {
          speak: [
            { type: 'speech', provider: 'openai', model: 'tts-1' },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('speak', TICKET))
      expect((error as BreadError).code).toBe('BLOB_STORE_NOT_CONFIGURED')
      expect(seen.calls).toBe(0)
      expect(reply.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws SPEECH_NOT_CONFIGURED when speech is unset', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        blobStore: memoryBlobStore(),
        pipelines: { speak: [{ type: 'speech', provider: 'openai', model: 'tts-1' }] },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('speak', TICKET))
      expect((error as BreadError).code).toBe('SPEECH_NOT_CONFIGURED')
    } finally {
      await stop()
    }
  })

  test('throws UNKNOWN_SPEECH_PROVIDER before the next step runs', async () => {
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        blobStore: memoryBlobStore(),
        speech: {},
        pipelines: {
          speak: [
            { type: 'speech', provider: 'openai', model: 'tts-1' },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('speak', TICKET))
      expect((error as BreadError).code).toBe('UNKNOWN_SPEECH_PROVIDER')
      expect(reply.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('passes voice through to a provider that requires it', async () => {
    let voice: string | undefined
    const model = {
      specificationVersion: 'v4',
      provider: 'fake.speech',
      modelId: 'aura-2',
      async doGenerate(options: { text: string; voice?: string }) {
        voice = options.voice
        if (!options.voice) throw new Error('voice is required')
        return {
          audio: AUDIO,
          warnings: [],
          response: {
            timestamp: new Date(),
            modelId: 'aura-2',
            headers: { 'content-type': 'audio/mpeg' },
          },
        }
      },
    } as SpeechModel
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        blobStore: memoryBlobStore(),
        speech: { deepgram: () => model },
        pipelines: {
          speak: [{ type: 'speech', provider: 'deepgram', model: 'aura-2', voice: 'aura-2-thalia-en' }],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('speak', TICKET))
      expect(error).toBeUndefined()
      expect(voice).toBe('aura-2-thalia-en')
    } finally {
      await stop()
    }
  })

  test('does not mint a session and keeps the audio crumb after sessions are deleted', async () => {
    const seen = { calls: 0 }
    const principal = { iss: 'https://idp.example', sub: 'ada' }
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        speech: speechRegistry(seen),
        pipelines: { speak: [{ type: 'speech', provider: 'openai', model: 'tts-1' }] },
      },
    })
    try {
      const before = (await bread.store.listSessions()).map((session) => session.id)
      const crumbs = await collect(bread.runPipeline('speak', TICKET, { principal }))
      const fileCrumb = crumbs.find((crumb) => crumb.type === 'file:generated') as FileGeneratedCrumb
      expect((await bread.store.listSessions()).map((session) => session.id)).toEqual(before)
      for (const session of await bread.store.listSessions()) await bread.store.deleteSession(session.id)
      const logged = await bread.store.getCrumbs!(fileCrumb.runId)
      expect(logged[0]?.type).toBe('file:generated')
      expect(logged[0]?.sessionId ?? null).toBeNull()
      expect((logged[0]?.crumb as { principal?: { iss: string; sub: string } }).principal).toEqual(principal)
      expect(await runVisible(bread.store, fileCrumb.runId, principal)).toBe(true)
      expect(await runVisible(bread.store, fileCrumb.runId, { iss: principal.iss, sub: 'other' })).toBe(false)
    } finally {
      await stop()
    }
  })

  test('a discarded loop attempt does not keep the speech audio', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const blobs = new Map<string, Uint8Array>()
    let puts = 0
    const blobStore: BlobStore = {
      async put(data) {
        const key = `blob-${++puts}`
        blobs.set(key, data)
        return { key, url: `memory://${key}` }
      },
      async get(key) {
        const id = key.startsWith('memory://') ? key.slice('memory://'.length) : key
        const data = blobs.get(id)
        return data ? { data } : undefined
      },
      async delete(key) {
        blobs.delete(key)
      },
    }
    const seen = { calls: 0 }
    const hostScript: ScriptStep[] = [
      { tool: 'core_start_loop', args: { pipeline: ['gate', 'second'], input: 'seed' } },
      { text: 'host done' },
    ]
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: {
            loop: {
              pool: ['gate', 'second'],
              maxIterations: 3,
              hooks: { onError: () => ({ action: 'recover', output: 'recovered' }) },
            },
          },
        }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        second: defineTestAgent({ model: 'second' }),
      },
      models: {
        host: mockScript(hostScript),
        gate: mockToolCallModel({
          toolName: 'human_approve',
          args: { question: 'gate?' },
          then: 'gate output',
        }),
        second: mockErrorModel('second down'),
      },
      config: {
        blobStore,
        speech: speechRegistry(seen),
      },
    })
    try {
      const first = await collect(bread.run('host', 'go'))
      const gate = first.find((crumb) => crumb.type === 'human:required') as { checkpointId: string }
      const record = await bread.store.getCheckpoint(gate.checkpointId)
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      await bread.store.saveCheckpoint({
        ...record,
        parent: {
          ...record.parent,
          remainingSteps: [
            { type: 'speech', provider: 'openai', model: 'tts-1' },
            ...record.parent.remainingSteps,
          ],
        },
      })
      const cont = await collect(bread.resume(gate.checkpointId, { approved: true }))
      expect(cont.some((crumb) => crumb.type === 'loop:iteration:end')).toBe(true)
      expect(seen.calls).toBe(1)
      expect(puts).toBe(1)
      expect(blobs.size).toBe(0)
      expect(cont.some((crumb) => crumb.type === 'file:generated')).toBe(false)
    } finally {
      await stop()
    }
  })
})
