import { z } from 'zod'
import type { BreadStore } from './storage/store.js'
import { loadDocumentSource, type DocLoadDeps } from './doc-load.js'
import { type DocumentConfig, type ToolDefinition, BreadError } from './types.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const docIngestSchema = z.object({
  title: z.string(),
  content: z.string(),
  source: z.string().optional(),
})

const docSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(20).optional(),
})

const docReadSchema = z.object({ id: z.string() })

const docLoadSchema = z.object({
  source: z.string().describe('Public https URL, or a file path under documents.fileRoot'),
  title: z.string().optional(),
})

type DocIngestArgs = z.infer<typeof docIngestSchema>
type DocSearchArgs = z.infer<typeof docSearchSchema>
type DocReadArgs = z.infer<typeof docReadSchema>
type DocLoadArgs = z.infer<typeof docLoadSchema>

// ---------------------------------------------------------------------------
// Document built-in tools — backed by the document methods of a BreadStore.
// ---------------------------------------------------------------------------

function requireDocs(store: BreadStore): Required<
  Pick<BreadStore, 'ingestDocument' | 'searchDocuments' | 'readDocument'>
> {
  if (!store.ingestDocument || !store.searchDocuments || !store.readDocument) {
    throw new BreadError(
      'The configured store does not implement document operations.',
      'STORE_NO_DOCUMENTS',
    )
  }
  return {
    ingestDocument: store.ingestDocument.bind(store),
    searchDocuments: store.searchDocuments.bind(store),
    readDocument: store.readDocument.bind(store),
  }
}

export function createDocTools(
  agentId: string,
  store: BreadStore,
  options?: DocumentConfig,
  deps?: DocLoadDeps,
): ToolDefinition[] {
  const docs = requireDocs(store)

  const docIngest: ToolDefinition<DocIngestArgs, { id: string; title: string }> = {
    name: 'core_doc_ingest',
    description: 'Store a document in the document store',
    schema: docIngestSchema,
    async execute(args) {
      return docs.ingestDocument({
        agentId,
        title: args.title,
        content: args.content,
        ...(args.source ? { source: args.source } : {}),
      })
    },
  }

  const docSearch: ToolDefinition<DocSearchArgs, unknown[]> = {
    name: 'core_doc_search',
    description: 'Search documents by keyword',
    schema: docSearchSchema,
    async execute(args) {
      return docs.searchDocuments({
        agentId,
        query: args.query,
        ...(args.limit ? { limit: args.limit } : {}),
      })
    },
  }

  const docRead: ToolDefinition<DocReadArgs, unknown> = {
    name: 'core_doc_read',
    description: 'Read the full content of a document by ID',
    schema: docReadSchema,
    async execute(args) {
      const doc = await docs.readDocument({ agentId, id: args.id })
      return doc ?? { error: 'Document not found' }
    },
  }

  const docLoad: ToolDefinition<DocLoadArgs, unknown> = {
    name: 'core_doc_load',
    description: 'Load a public https URL, or a file under documents.fileRoot, and ingest it',
    schema: docLoadSchema,
    async execute(args) {
      const content = await loadDocumentSource(args.source, options, deps)
      const title = args.title ?? args.source
      const { id } = await docs.ingestDocument({ agentId, title, content, source: args.source })
      return { id, title, length: content.length }
    },
  }

  return [docIngest, docSearch, docRead, docLoad]
}
