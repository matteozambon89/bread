import { defineAgent } from '@bread/core'
import { z } from 'zod'

// Entrypoint, driven over AG-UI (see bread.config.ts). Delegates to `investigator` with
// 'mediate' visibility so the client sees subagent:run:start/end framing around the
// investigation instead of its raw token stream — the crumb-relabeling path this example
// is meant to exercise.
export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  supervisor: {
    max: 1,
    agents: [{ agentId: 'investigator', visibility: 'mediate' }],
  },
})
