import { BreadError, type Principal, type ToolContext } from '@breadai/core'

export function memoryScope(ctx: ToolContext): { agentId: string; principal: Principal } {
  if (ctx.principal == null) {
    throw new BreadError(
      'A run principal is required to use memory.',
      'MEMORY_PRINCIPAL_REQUIRED',
      { agentId: ctx.agentId, runId: ctx.runId },
    )
  }
  return { agentId: ctx.agentId, principal: ctx.principal }
}
