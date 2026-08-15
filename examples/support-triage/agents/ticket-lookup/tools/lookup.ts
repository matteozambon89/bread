import { defineTool } from '@breadai/core'
import { z } from 'zod'

// Self-contained mock dataset — no external API, so the example runs offline like
// hitl-approval/loop/researcher-writer do. Real usage would call an order/ticket API.
const TICKETS: Record<
  string,
  { item: string; orderDate: string; amountUsd: number; note: string }
> = {
  'ord-1001': {
    item: 'Wireless keyboard',
    orderDate: '2026-07-20',
    amountUsd: 49.99,
    note: 'Arrived with a cracked case, customer sent photos.',
  },
  'ord-1002': {
    item: 'E-book: "Sourdough Basics"',
    orderDate: '2026-06-01',
    amountUsd: 9.99,
    note: 'Customer says they were charged twice.',
  },
  'ord-1003': {
    item: 'Desk lamp',
    orderDate: '2025-11-02',
    amountUsd: 34.5,
    note: 'Customer wants a refund, no stated reason.',
  },
}

export default defineTool({
  name: 'lookup_ticket',
  description: 'Look up a support ticket by order id and return its details.',
  schema: z.object({ orderId: z.string() }),
  outputSchema: z.object({
    found: z.boolean(),
    item: z.string().optional(),
    orderDate: z.string().optional(),
    amountUsd: z.number().optional(),
    note: z.string().optional(),
  }),
  async execute({ orderId }) {
    const ticket = TICKETS[orderId.toLowerCase()]
    if (!ticket) return { found: false }
    return { found: true, ...ticket }
  },
})
