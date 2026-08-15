import { defineAgent } from '@breadai/core'
import { z } from 'zod'

// Loop host: composes ticket-lookup -> policy-check, judges the result, and iterates
// if it needs another look before deciding. Also owns the HITL gate (approve_refund) —
// a loop and a human tool are orthogonal features, both legal on the same agent.
export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  loop: {
    pool: ['ticket-lookup', 'policy-check'],
    maxIterations: 3,
  },
})
