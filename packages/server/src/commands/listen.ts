import type {
  AgentRegistry,
  BreadConfig,
  BreadInstance,
  TaskRegistry,
} from '@breadai/core'
import type { ServerOptions } from '../server.js'

/** Runtime listen adapter — Bun (`@breadai/runtime-bun`) or Node (`@breadai/runtime-node`). */
export type ListenFn = (
  config: BreadConfig,
  agents: AgentRegistry,
  opts?: ServerOptions,
  tasks?: TaskRegistry,
) => Promise<{ bread: BreadInstance; stop: () => Promise<void> }>
