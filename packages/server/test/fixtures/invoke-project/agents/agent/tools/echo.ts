import { z } from 'zod'
import { defineTool } from '@breadai/core'

export default defineTool({
  name: 'echo',
  description: 'Echo the given text back',
  schema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
})
