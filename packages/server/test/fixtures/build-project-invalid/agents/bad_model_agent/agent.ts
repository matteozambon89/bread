import { z } from 'zod'
import { defineAgent } from '@breadai/core'

export default defineAgent({
  // Empty model id — hits runBuild's "incomplete model config" branch.
  model: { provider: 'openai', model: '' },
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.string(),
  output: { format: 'text' },
})
