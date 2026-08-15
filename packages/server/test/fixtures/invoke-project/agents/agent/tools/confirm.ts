import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'

export default defineHumanTool('confirm', z.object({ ok: z.boolean() }))
