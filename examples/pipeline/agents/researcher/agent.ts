import { defineAgent } from '@bread/core'
import { z } from 'zod'

export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
  },
  inputSchema: z.string(),
  outputSchema: z.array(z.string()),
  output: {
    format: {
      name: 'lines',
      parse: (raw) => raw.split('\n').map((s) => s.trim()).filter(Boolean),
    },
  },
})
