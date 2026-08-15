import { defineHumanTool } from '@breadai/core'
import { z } from 'zod'

export default defineHumanTool(
  'approve_refund',
  z.object({
    orderId: z.string(),
    amountUsd: z.number(),
    reason: z.string(),
  }),
)
