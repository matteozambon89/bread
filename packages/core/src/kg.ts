import { z } from 'zod'
import type { BreadStore } from './storage/store.js'
import { type ToolDefinition, BreadError } from './types.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const kgStoreSchema = z.object({
  label: z.string().describe('Entity or concept label'),
  data: z.record(z.string(), z.unknown()).optional().describe('Additional properties'),
  relatesTo: z
    .object({ id: z.string(), relation: z.string() })
    .optional()
    .describe('Optional relation to an existing node'),
})

const kgQuerySchema = z.object({
  query: z.string().describe('Search term to match against labels'),
  limit: z.number().int().min(1).max(50).optional(),
})

const kgForgetSchema = z.object({
  id: z.string().describe('Node ID to remove'),
})

type KgStoreArgs = z.infer<typeof kgStoreSchema>
type KgQueryArgs = z.infer<typeof kgQuerySchema>
type KgForgetArgs = z.infer<typeof kgForgetSchema>

// ---------------------------------------------------------------------------
// KG built-in tools — backed by the knowledge methods of a BreadStore.
// ---------------------------------------------------------------------------

function requireKg(store: BreadStore): Required<
  Pick<BreadStore, 'addKnowledgeNode' | 'addKnowledgeEdge' | 'queryKnowledge' | 'forgetKnowledge'>
> {
  if (
    !store.addKnowledgeNode ||
    !store.addKnowledgeEdge ||
    !store.queryKnowledge ||
    !store.forgetKnowledge
  ) {
    throw new BreadError(
      'The configured store does not implement knowledge-graph operations.',
      'STORE_NO_KNOWLEDGE',
    )
  }
  return {
    addKnowledgeNode: store.addKnowledgeNode.bind(store),
    addKnowledgeEdge: store.addKnowledgeEdge.bind(store),
    queryKnowledge: store.queryKnowledge.bind(store),
    forgetKnowledge: store.forgetKnowledge.bind(store),
  }
}

export function createKgTools(agentId: string, store: BreadStore): ToolDefinition[] {
  const kg = requireKg(store)

  const kgStore: ToolDefinition<KgStoreArgs, { id: string; label: string }> = {
    name: 'core_kg_store',
    description: 'Store a fact or entity in the knowledge graph',
    schema: kgStoreSchema,
    async execute(args, ctx) {
      const node = await kg.addKnowledgeNode({
        agentId,
        sessionId: ctx.sessionId,
        label: args.label,
        ...(args.data ? { data: args.data } : {}),
      })
      if (args.relatesTo) {
        await kg.addKnowledgeEdge({
          fromId: node.id,
          toId: args.relatesTo.id,
          relation: args.relatesTo.relation,
        })
      }
      return node
    },
  }

  const kgQuery: ToolDefinition<KgQueryArgs, unknown[]> = {
    name: 'core_kg_query',
    description: 'Search the knowledge graph by label',
    schema: kgQuerySchema,
    async execute(args) {
      return kg.queryKnowledge({
        agentId,
        query: args.query,
        ...(args.limit ? { limit: args.limit } : {}),
      })
    },
  }

  const kgForget: ToolDefinition<KgForgetArgs, { deleted: boolean }> = {
    name: 'core_kg_forget',
    description: 'Remove a node from the knowledge graph by ID',
    schema: kgForgetSchema,
    async execute(args) {
      return kg.forgetKnowledge({ id: args.id })
    },
  }

  return [kgStore, kgQuery, kgForget]
}

// ---------------------------------------------------------------------------
// Auto-inject KG context into the system prompt.
// ---------------------------------------------------------------------------

export async function buildKgContext(
  store: BreadStore,
  agentId: string,
  sessionId: string,
  maxTokens = 2000,
): Promise<string> {
  const rows = (await store.knowledgeContext?.({ agentId, sessionId, limit: 100 })) ?? []
  if (rows.length === 0) return ''

  const entries = rows.map((r) => {
    const extras = Object.entries(r.data)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')
    return extras ? `- ${r.label} (${extras})` : `- ${r.label}`
  })

  const ctx = `## Knowledge Graph Context\n${entries.join('\n')}`
  return ctx.length > maxTokens * 4 ? ctx.slice(0, maxTokens * 4) : ctx
}
