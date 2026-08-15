import { defineAgent } from '@bread/core'
import { z } from 'zod'

// LLM supervisor: the editor's model drives `core_delegate` per prompt.md —
// researcher + fact-checker in one parallel turn (max 2 concurrent), then the
// writer over the verified facts, then its own final polish.
export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  supervisor: {
    max: 2,
    agents: [
      { agentId: 'researcher', visibility: 'passthrough' },
      { agentId: 'fact-checker', visibility: 'mediate' },
      { agentId: 'writer', visibility: 'passthrough' },
    ],
  },
})
