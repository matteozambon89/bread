import { defineAgent } from '@bread/core'
import { z } from 'zod'

export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.unknown(),
  outputSchema: z.string(),
  output: { format: 'text' },
})
