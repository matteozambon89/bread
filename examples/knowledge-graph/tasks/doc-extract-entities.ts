import { defineTask } from '@breadai/core'
import { z } from 'zod'

// A one-shot task compiled to the `doc_extract_entities` tool. `beforeRun`
// loads the stored document, the model extracts entities, and `afterRun`
// persists each as a knowledge-graph node. Agents opt in via `tasks: [...]`.
export default defineTask({
  name: 'doc_extract_entities',
  description: 'Extract named entities from a stored document and add them to the knowledge graph',
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
      let stored = 0
      if (ctx.store.addKnowledgeNode) {
        for (const entity of ctx.output.entities) {
          await ctx.store.addKnowledgeNode({
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
            label: entity.name,
            ...(entity.type ? { data: { type: entity.type } } : {}),
          })
          stored++
        }
      }
      return { output: { documentId, entities: ctx.output.entities, stored } }
    },
  },
})
