import { defineHumanTool } from '@bread/core'
import { z } from 'zod'

export default defineHumanTool('approve_publish', z.object({ url: z.string(), summary: z.string() }))
