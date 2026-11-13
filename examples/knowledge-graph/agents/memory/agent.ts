import { defineAgent } from '@breadai/core'
import { z } from 'zod'

// `plugins.memory` opts this agent into memorize, recall, forget, and dream.
// Nothing from those rows is pasted into a later run.
// `documents: {}` auto-attaches the doc tools (ingest/read/...). core_doc_load
// fetches public https URLs only; local files stay off unless fileRoot is set.
// `tasks` exposes doc_extract_entities, which returns names and does not store them.
export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  documents: {},
  plugins: { memory: {} },
  tasks: ['doc_extract_entities'],
})
