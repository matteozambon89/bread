import { z } from 'zod'
import { defineHumanTool } from '@bread/core'

export default defineHumanTool('ask_human', z.object({ question: z.string() }))
