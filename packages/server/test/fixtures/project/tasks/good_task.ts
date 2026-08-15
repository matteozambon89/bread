import { z } from 'zod'
import { defineTask } from '@bread/core'

export default defineTask({
  name: 'summarize',
  description: 'Summarize the given text',
  model: { provider: 'openai', model: 'gpt-4o-mini' },
  instructions: 'Summarize the input.',
  schema: z.object({ text: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
})
