import type { BreadPlugin } from '@bread/core'
import { type A2ABread, type AgentSkillMeta } from './agent-meta.js'
import { type AgentCardV03, buildAgentCardV03 } from './v03/agent-card.js'
import { handleRpcRequestV03 } from './v03/rpc.js'
import { type AgentCardV1, buildAgentCardV1 } from './v1/agent-card.js'
import { handleRpcRequestV1 } from './v1/rpc.js'

export type { A2ABread, AgentSkillMeta } from './agent-meta.js'
export type { TaskStatus } from './task-status.js'
export { deriveTaskStatus } from './task-status.js'
export type { AgentCardV03 } from './v03/agent-card.js'
export { buildAgentCardV03 } from './v03/agent-card.js'
export { handleRpcRequestV03 } from './v03/rpc.js'
export { handleStreamRequestV03 } from './v03/stream.js'
export { handleTasksCancelV03, handleTasksGetV03, handleTasksResubscribeV03 } from './v03/tasks.js'
export type { AgentCardV1 } from './v1/agent-card.js'
export { buildAgentCardV1 } from './v1/agent-card.js'
export { handleRpcRequestV1 } from './v1/rpc.js'
export { handleStreamRequestV1 } from './v1/stream.js'
export { handleTasksCancelV1, handleTasksGetV1, handleTasksResubscribeV1 } from './v1/tasks.js'

// A2A server plugin — serves an Agent Card (discovery document) and a
// JSON-RPC endpoint that invokes one bread agent synchronously, per the A2A
// spec. Supports the two current spec generations side by side: v0.3.x
// (message/send, the interoperable default) and v1.0 (SendMessage, its
// JSON-RPC binding only — REST/gRPC bindings are out of scope). One plugin
// instance serves exactly one agent under exactly one spec version; expose
// more agents or both versions at once by mounting `a2aServer(...)` again
// with a different `agentId`/`specVersion`/`url`/`cardPath`.
export interface A2AServerConfig {
  /** The bread agent this server exposes. One Card = one agent identity. */
  agentId: string
  /** Full external URL of the JSON-RPC endpoint — also the Card's own URL field. */
  url: string
  /**
   * Path the Agent Card is served at (e.g. `/.well-known/agent-card.json`, the spec's
   * well-known location). Required, not defaulted: mounting a second `a2aServer()` in the
   * same process needs a distinct path from the first or its Card is never reachable — Hono
   * serves only the first handler registered at a given path, silently.
   */
  cardPath: string
  /** Which A2A spec generation to serve. Defaults to '0.3', the interoperable one. */
  specVersion?: '0.3' | '1.0'
  name?: string
  description?: string
  version?: string
}

// Minimal shape of the Hono app passed to BreadPlugin.routes — avoids a hono dep.
interface MinimalApp {
  get(path: string, handler: (c: { req: { raw: Request } }) => Response | Promise<Response>): unknown
  post(path: string, handler: (c: { req: { raw: Request } }) => Response | Promise<Response>): unknown
}

export function a2aServer(config: A2AServerConfig): BreadPlugin {
  let breadRef: A2ABread | null = null
  const specVersion = config.specVersion ?? '0.3'
  // Per-plugin-instance, in-memory — not persisted, not module-level (so
  // separate a2aServer() mounts, e.g. in tests, never share entries). Only
  // ever populated for a run started via this instance's own message/stream:
  // a synchronous message/send never exposes its runId to the caller until
  // the run has already finished, so there's no window to cancel it either
  // way. See v03/tasks.ts's handleTasksCancelV03 for the full rationale.
  const cancelRegistry = new Map<string, AbortController>()

  return {
    name: 'a2a_server',
    async init(bread) {
      breadRef = bread as unknown as A2ABread
    },
    routes(app) {
      const rpcPath = new URL(config.url).pathname
      ;(app as MinimalApp).get(config.cardPath, (c) => {
        if (!breadRef) return new Response('bread not started', { status: 503 })
        const card: AgentCardV03 | AgentCardV1 =
          specVersion === '1.0' ? buildAgentCardV1(breadRef, config.agentId, config) : buildAgentCardV03(breadRef, config.agentId, config)
        return Response.json(card)
      })
      ;(app as MinimalApp).post(rpcPath, (c) => {
        if (!breadRef) return new Response('bread not started', { status: 503 })
        return specVersion === '1.0'
          ? handleRpcRequestV1(breadRef, config.agentId, c.req.raw, cancelRegistry)
          : handleRpcRequestV03(breadRef, config.agentId, c.req.raw, cancelRegistry)
      })
    },
  }
}

