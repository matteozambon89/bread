import { defineHumanTool } from '@breadai/core'
import { z } from 'zod'

export default defineHumanTool('approve_publish', z.object({ url: z.string(), summary: z.string() }))
