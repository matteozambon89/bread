import { defineAgent } from '@breadai/core'
import { z } from 'zod'

// autoInject pulls prior knowledge-graph context into the system prompt, so a
// second run in the same session benefits from what the first run stored.
// `documents: {}` auto-attaches the doc tools (ingest/read/...). core_doc_load
// fetches public https URLs only; local files stay off unless fileRoot is set.
// `knowledge` auto-attaches the KG tools, and `tasks` exposes the
// doc_extract_entities task-tool (defined in ../../tasks/doc-extract-entities.ts).
export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  knowledge: { autoInject: true, maxTokens: 1000 },
  documents: {},
  tasks: ['doc_extract_entities'],
})
