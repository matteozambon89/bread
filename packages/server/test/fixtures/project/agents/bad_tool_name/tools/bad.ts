import { z } from 'zod'
import { defineTool } from '@breadai/core'

export default defineTool({
  name: 'Bad-Name',
  description: 'A tool whose name is not snake_case',
  schema: z.object({}),
  execute: async () => ({}),
})
