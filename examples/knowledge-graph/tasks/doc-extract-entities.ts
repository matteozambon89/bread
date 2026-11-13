import { defineTask } from '@breadai/core'
import { z } from 'zod'

// A one-shot task compiled to the `doc_extract_entities` tool. `beforeRun`
// loads the stored document and the model extracts names. `afterRun` returns
// those names and does not store them. Agents opt in via `tasks: [...]`.
export default defineTask({
  name: 'doc_extract_entities',
  description: 'Extract named entities from a stored document and return the names',
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  instructions:
    'Extract the named entities (people, places, organizations, concepts) from the document. ' +
    'Return each with a short `type`. Do not invent entities that are not present.',
  schema: z.object({ documentId: z.string().describe('Id of a previously ingested document') }),
  outputSchema: z.object({
    entities: z.array(z.object({ name: z.string(), type: z.string().optional() })),
  }),
  hooks: {
    async beforeRun(ctx) {
      const { documentId } = ctx.input
      const doc = await ctx.store.readDocument?.({ agentId: ctx.agentId, id: documentId })
      if (!doc) throw new Error(`Document not found: ${documentId}`)
      return { action: 'continue', input: { documentId, content: doc.content } }
    },
    async afterRun(ctx) {
      const { documentId } = ctx.input
      return { output: { documentId, entities: ctx.output.entities } }
    },
  },
})
