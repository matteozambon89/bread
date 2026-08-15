import { z } from 'zod'
import { defineAgent } from '@bread/core'

export default defineAgent({
  model: { provider: 'mock', model: 'default' },
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  output: { format: 'text' },
})
