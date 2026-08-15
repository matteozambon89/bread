import { z } from 'zod'
import { defineAgent } from '@breadai/core'

export default defineAgent({
  model: { provider: 'openai', model: 'gpt-4o-mini' },
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  output: { format: 'text' },
})
