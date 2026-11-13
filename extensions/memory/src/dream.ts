import { generateObject, type LanguageModel } from 'ai'
import { BreadError, type MemoryRecord, type SessionMessage, type ToolContext } from '@breadai/core'
import { z } from 'zod'
import type { MemoryBackend } from './backend.js'
import { memoryScope } from './scope.js'

const DREAM_MEMORY_LIMIT = 100
const DREAM_MESSAGE_LIMIT = 50
const DREAM_FAILED_MESSAGE = 'Memory dream failed'

export type MemoryModel = LanguageModel | (() => LanguageModel | Promise<LanguageModel>)

const dreamSchema = z.object({
  memories: z.array(
    z.object({
      content: z.string().min(1),
      replaces: z.array(z.string()),
    }),
  ),
})

function dreamFailed(ctx: ToolContext, cause: unknown): BreadError {
  return new BreadError(
    DREAM_FAILED_MESSAGE,
    'MEMORY_DREAM_FAILED',
    { agentId: ctx.agentId, runId: ctx.runId },
    cause,
  )
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content) ?? ''
}

function dreamPrompt(memories: MemoryRecord[], messages: SessionMessage[]): string {
  const memoryBlock = memories.map((row) => `${row.id}\t${row.content}`).join('\n')
  const transcript = messages.map((message) => `${message.role}\t${messageText(message.content)}`).join('\n')
  return [
    'Consolidate durable facts. Return replacement memories.',
    'Each replaces entry must be an id from the memories below.',
    'Memories:',
    memoryBlock,
    'Transcript:',
    transcript,
  ].join('\n')
}

export async function dream(input: {
  backend: MemoryBackend
  model: MemoryModel
  ctx: ToolContext
}): Promise<{ written: MemoryRecord[]; forgotten: string[] }> {
  const scope = memoryScope(input.ctx)
  if (input.ctx.signal?.aborted) throw dreamFailed(input.ctx, input.ctx.signal.reason)

  const memories = await input.backend.listMemories({
    ...scope,
    limit: DREAM_MEMORY_LIMIT,
    ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
  })
  if (input.backend.linkMissing) {
    await input.backend.linkMissing(memories, scope, input.ctx.signal)
  }
  const messages = await input.backend.getMessages(input.ctx.sessionId)
  const transcript = messages.slice(-DREAM_MESSAGE_LIMIT)

  let languageModel: LanguageModel
  try {
    languageModel = typeof input.model === 'function' ? await input.model() : input.model
  } catch (cause) {
    throw dreamFailed(input.ctx, cause)
  }

  let planned: z.infer<typeof dreamSchema>
  try {
    const result = await generateObject({
      model: languageModel,
      schema: dreamSchema,
      prompt: dreamPrompt(memories, transcript),
      maxRetries: 0,
      ...(input.ctx.signal ? { abortSignal: input.ctx.signal } : {}),
    })
    planned = result.object
  } catch (cause) {
    throw dreamFailed(input.ctx, cause)
  }

  // Only ids from the page just read. An invented id, or another caller's id,
  // is not a forget target.
  const loaded = new Set(memories.map((row) => row.id))
  const replaceIds: string[] = []
  const seen = new Set<string>()
  for (const item of planned.memories) {
    for (const id of item.replaces) {
      if (!loaded.has(id) || seen.has(id)) continue
      seen.add(id)
      replaceIds.push(id)
    }
  }

  const written: MemoryRecord[] = []
  for (const item of planned.memories) {
    written.push(
      await input.backend.addMemory({
        ...scope,
        content: item.content,
        ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
      }),
    )
  }

  // No transaction with the writes above: a failed forget must leave the new row.
  const forgotten: string[] = []
  for (const id of replaceIds) {
    const result = await input.backend.forgetMemory({
      ...scope,
      id,
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
    })
    if (result.deleted) forgotten.push(id)
  }
  return { written, forgotten }
}
