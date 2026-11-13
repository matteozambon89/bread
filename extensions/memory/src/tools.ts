import type { ToolDefinition } from '@breadai/core'
import { z } from 'zod'
import type { MemoryBackend } from './backend.js'
import { dream, type MemoryModel } from './dream.js'
import { memoryScope } from './scope.js'

const memorizeSchema = z.object({ content: z.string().min(1) })
const recallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
})
const forgetSchema = z.object({ id: z.string().min(1) })
const dreamArgsSchema = z.object({})

export function createMemoryTools(backend: MemoryBackend, model: MemoryModel): ToolDefinition[] {
  return [
    {
      name: 'memorize',
      description: 'Store one durable fact for the current caller',
      schema: memorizeSchema,
      async execute(args, ctx) {
        const { content } = memorizeSchema.parse(args)
        return backend.addMemory({
          ...memoryScope(ctx),
          content,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      },
    },
    {
      name: 'recall',
      description: 'Search durable facts for the current caller',
      schema: recallSchema,
      async execute(args, ctx) {
        const parsed = recallSchema.parse(args)
        return backend.searchMemories({
          ...memoryScope(ctx),
          query: parsed.query,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        })
      },
    },
    {
      name: 'forget',
      description: 'Delete one durable fact owned by the current caller',
      schema: forgetSchema,
      ask: true,
      async execute(args, ctx) {
        const { id } = forgetSchema.parse(args)
        return backend.forgetMemory({
          ...memoryScope(ctx),
          id,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      },
    },
    {
      name: 'dream',
      description: 'Consolidate durable facts from existing memories and the recent transcript',
      schema: dreamArgsSchema,
      ask: true,
      execute(_args, ctx) {
        return dream({ backend, model, ctx })
      },
    },
  ]
}
