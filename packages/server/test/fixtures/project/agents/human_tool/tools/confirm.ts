import { z } from 'zod'
import { defineHumanTool } from '@bread/core'

export default defineHumanTool('confirm', z.object({ ok: z.boolean() }))
