import { defineAgent } from '@bread/core'
import { z } from 'zod'

// Host/judge agent. It composes a drafter -> critic pipeline at runtime, runs it,
// judges the result, and re-iterates the SAME pipeline until satisfied or the
// (consumer-owned) cap of 4 iterations is reached.
export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  loop: {
    pool: ['drafter', 'critic'],
    maxIterations: 4,
  },
})
