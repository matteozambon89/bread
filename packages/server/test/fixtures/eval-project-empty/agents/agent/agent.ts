import { z } from 'zod'
import { defineAgent } from '@bread/core'

export default defineAgent({
  model: { provider: 'openai', model: 'gpt-4o-mini' },
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  output: { format: 'text' },
})
