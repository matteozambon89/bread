import { defineAgent } from '@bread/core'
import { z } from 'zod'

// autoInject pulls prior knowledge-graph context into the system prompt, so a
// second run in the same session benefits from what the first run stored.
// `documents: {}` auto-attaches the doc tools (ingest/read/...), `knowledge`
// auto-attaches the KG tools, and `tasks` exposes the doc_extract_entities
// task-tool (defined in ../../tasks/doc-extract-entities.ts).
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
