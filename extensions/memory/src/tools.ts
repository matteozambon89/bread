import type { ToolDefinition } from '@breadai/core'
import { z } from 'zod'
import { dream, type MemoryModel } from './dream.js'
import { memoryScope } from './scope.js'
import type { MemoryStore } from './store-backend.js'

const memorizeSchema = z.object({ content: z.string().min(1) })
const recallSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
})
const forgetSchema = z.object({ id: z.string().min(1) })
const dreamArgsSchema = z.object({})

export function createMemoryTools(store: MemoryStore, model: MemoryModel): ToolDefinition[] {
  return [
    {
      name: 'memorize',
      description: 'Store one durable fact for the current caller',
      schema: memorizeSchema,
      async execute(args, ctx) {
        const { content } = memorizeSchema.parse(args)
        return store.addMemory({ ...memoryScope(ctx), content })
      },
    },
    {
      name: 'recall',
      description: 'Search durable facts for the current caller',
      schema: recallSchema,
      async execute(args, ctx) {
        const parsed = recallSchema.parse(args)
        return store.searchMemories({
          ...memoryScope(ctx),
          query: parsed.query,
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
        return store.forgetMemory({ ...memoryScope(ctx), id })
      },
    },
    {
      name: 'dream',
      description: 'Consolidate durable facts from existing memories and the recent transcript',
      schema: dreamArgsSchema,
      ask: true,
      execute(_args, ctx) {
        return dream({ store, model, ctx })
      },
    },
  ]
}
