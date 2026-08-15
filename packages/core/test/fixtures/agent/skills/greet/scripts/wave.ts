import { z } from 'zod'
import { defineTool } from '@bread/core'

export default defineTool({
  name: 'wave',
  description: 'Return a waving gesture',
  schema: z.object({ to: z.string() }),
  execute: async ({ to }) => ({ wavedAt: to }),
})
