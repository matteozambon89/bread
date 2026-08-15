import { defineTool } from '@bread/core'
import { z } from 'zod'

// Fixed, deterministic mock policy — real usage would call a rules engine or a
// human-authored policy document via RAG. Kept simple so the example's HITL branch
// (refund proposed) is reliably reachable without depending on model creativity.
const REFUND_WINDOW_DAYS = 60

export default defineTool({
  name: 'check_refund_policy',
  description: 'Evaluate whether an order is eligible for a refund under store policy.',
  schema: z.object({
    orderDate: z.string().describe('ISO date, e.g. 2026-07-20'),
    amountUsd: z.number(),
    reason: z.string(),
  }),
  outputSchema: z.object({
    eligible: z.boolean(),
    refundAmountUsd: z.number().optional(),
    explanation: z.string(),
  }),
  async execute({ orderDate, amountUsd, reason }) {
    const ageDays = Math.floor((Date.now() - Date.parse(orderDate)) / 86_400_000)
    const damagedOrDuplicate = /crack|damag|duplicate|charged twice|broken/i.test(reason)

    if (damagedOrDuplicate) {
      return {
        eligible: true,
        refundAmountUsd: amountUsd,
        explanation: 'Damaged item or billing error — eligible regardless of order age.',
      }
    }
    if (ageDays <= REFUND_WINDOW_DAYS) {
      return {
        eligible: true,
        refundAmountUsd: amountUsd,
        explanation: `Order is ${ageDays} days old, within the ${REFUND_WINDOW_DAYS}-day window.`,
      }
    }
    return {
      eligible: false,
      explanation: `Order is ${ageDays} days old, past the ${REFUND_WINDOW_DAYS}-day window and no damage/billing error reported.`,
    }
  },
})
