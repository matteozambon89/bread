import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { serveStdio as sdkServeStdio } from '@modelcontextprotocol/server/stdio'
import type { McpHttpHandler } from '@modelcontextprotocol/server'
import {
  type BreadInstance,
  type ToolContext,
  type ToolDefinition,
  buildToolCredentials,
  envProvider,
} from '@breadai/core'
import { v7 as uuidv7 } from 'uuid'
import { isObjectSchema, toMcpInputSchema, toMcpOutputSchema, toStructured, unwrapInput } from './schema.js'

// The slice of the public BreadInstance this ingress consumes.
export type McpBread = Pick<
  BreadInstance,
  'run' | 'runTask' | 'agents' | 'tasks' | 'pluginTools' | 'credentials' | 'blobStore'
>

export interface ExposeConfig {
  /** Agent ids to expose as MCP tools. */
  agents?: string[]
  /** Agent+skill pairs to expose as MCP tools. */
  skills?: { agent: string; skill: string }[]
  /** Task ids (from the task registry) to expose as MCP tools. */
  tasks?: string[]
  /**
   * Individual tools to expose directly, invoked via `execute()` without a
   * model in the loop. A bare string names a plugin-contributed tool; an
   * `{agent, tool}` pair names a tool owned by one agent's own tool set.
   */
  tools?: (string | { agent: string; tool: string })[]
  /** `stdio` (default) connects on init; `http` mounts on the server's Hono app. */
  transport?: 'stdio' | 'http'
  /** HTTP mount path when `transport: 'http'`. Default `/mcp`. */
  path?: string
  /**
   * Allowed Host/Origin hostnames for DNS-rebinding protection on the HTTP
   * route (port-agnostic — same convention as the SDK's own validators).
   * Defaults to localhost-only; set this when the server is reachable under
   * a real hostname.
   */
  allowedHosts?: string[]
}

function synthesizeToolContext(agentId: string, bread: McpBread, def: ToolDefinition): ToolContext {
  const id = uuidv7()
  return {
    agentId,
    sessionId: id,
    runId: id,
    credentials: buildToolCredentials(def, bread.credentials ?? envProvider()),
    ...(bread.blobStore ? { blobStore: bread.blobStore } : {}),
  }
}

function findAgentTool(bread: McpBread, agentId: string, toolName: string): ToolDefinition {
  const cfg = bread.agents.get(agentId)?.config as { _tools?: ToolDefinition[] } | undefined
  const def = cfg?._tools?.find((t) => t.name === toolName)
  if (!def) throw new Error(`mcp_server: agent "${agentId}" has no tool named "${toolName}"`)
  return def
}

function findPluginTool(bread: McpBread, name: string): ToolDefinition {
  const def = bread.pluginTools.find((p) => p.def.name === name)?.def
  if (!def) throw new Error(`mcp_server: no plugin tool named "${name}" is registered`)
  return def
}

// `exactOptionalPropertyTypes` rejects `outputSchema: undefined` — omit the
// key entirely when there's nothing to translate.
function toolRegistration(
  description: string,
  inputSchema: ReturnType<typeof toMcpInputSchema>,
  outputSchema: ReturnType<typeof toMcpOutputSchema>,
): { description: string; inputSchema: typeof inputSchema; outputSchema?: NonNullable<typeof outputSchema> } {
  return { description, inputSchema, ...(outputSchema ? { outputSchema } : {}) }
}

// Build an MCP server that exposes selected bread agents, tasks, tools, and
// agent+skill combinations as MCP tools, consuming only the public
// BreadInstance surface. Agents/skills run through
// `bread.run(..., { mode: 'sync' })` (the model decides what happens); tasks
// run through `bread.runTask` (full hook/audit treatment, crumb-silent —
// standalone task semantics); direct tool invocation bypasses hooks/crumbs
// entirely — there is no run to attach `ToolDefinition.hooks`/`tool:call`/
// `tool:result` crumbs to, so those are skipped. This is a deliberate,
// documented limitation, not an oversight.
export function buildMcpServer(bread: McpBread, expose: ExposeConfig): McpServer {
  const server = new McpServer({ name: 'bread', version: '0.1.0' })

  for (const agentId of expose.agents ?? []) {
    const agentDef = bread.agents.get(agentId)
    if (!agentDef) throw new Error(`mcp_server: agent "${agentId}" is not registered`)
    const { inputSchema, outputSchema } = agentDef.config
    const inputWrapped = !isObjectSchema(inputSchema)
    const outputWrapped = !isObjectSchema(outputSchema)
    server.registerTool(
      agentId,
      toolRegistration(
        `Run the bread "${agentId}" agent`,
        toMcpInputSchema(inputSchema),
        toMcpOutputSchema(outputSchema),
      ),
      async (args: unknown) => {
        const input = unwrapInput(args, inputWrapped)
        const { output } = await bread.run(agentId, input, { mode: 'sync' })
        return toStructured(output, outputWrapped)
      },
    )
  }

  for (const { agent, skill } of expose.skills ?? []) {
    const agentDef = bread.agents.get(agent)
    if (!agentDef) throw new Error(`mcp_server: agent "${agent}" is not registered`)
    const { inputSchema, outputSchema } = agentDef.config
    const inputWrapped = !isObjectSchema(inputSchema)
    const outputWrapped = !isObjectSchema(outputSchema)
    server.registerTool(
      `${agent}__${skill}`,
      toolRegistration(
        `Run "${agent}" with the "${skill}" skill`,
        toMcpInputSchema(inputSchema),
        toMcpOutputSchema(outputSchema),
      ),
      async (args: unknown) => {
        const input = unwrapInput(args, inputWrapped)
        const { output } = await bread.run(agent, input, { mode: 'sync', skill })
        return toStructured(output, outputWrapped)
      },
    )
  }

  for (const taskId of expose.tasks ?? []) {
    const taskDef = bread.tasks.get(taskId)
    if (!taskDef) throw new Error(`mcp_server: task "${taskId}" is not registered`)
    const { schema, outputSchema } = taskDef.config
    const inputWrapped = !isObjectSchema(schema)
    const outputWrapped = !isObjectSchema(outputSchema)
    server.registerTool(
      taskId,
      toolRegistration(taskDef.config.description, toMcpInputSchema(schema), toMcpOutputSchema(outputSchema)),
      async (args: unknown) => {
        const input = unwrapInput(args, inputWrapped)
        const out = await bread.runTask(taskId, input, { agentId: 'mcp' })
        return toStructured(out, outputWrapped)
      },
    )
  }

  for (const entry of expose.tools ?? []) {
    const isAgentTool = typeof entry !== 'string'
    const def = isAgentTool ? findAgentTool(bread, entry.agent, entry.tool) : findPluginTool(bread, entry)
    const name = isAgentTool ? `${entry.agent}__${entry.tool}` : entry
    const agentId = isAgentTool ? entry.agent : 'mcp'
    const inputWrapped = !isObjectSchema(def.schema)
    // No declared outputSchema at all (common for plain tools) means nothing
    // to wrap against — pass the raw return value through as-is.
    const outputWrapped = def.outputSchema ? !isObjectSchema(def.outputSchema) : false
    server.registerTool(
      name,
      toolRegistration(def.description, toMcpInputSchema(def.schema), toMcpOutputSchema(def.outputSchema)),
      async (args: unknown) => {
        const input = unwrapInput(args, inputWrapped)
        const toolCtx = synthesizeToolContext(agentId, bread, def)
        const executed = def.execute(input, toolCtx)
        // A streaming tool's execute (an AsyncIterable<R>) is drained to its
        // last yielded value here — this direct-invocation path has no
        // hooks/crumbs either way (pre-existing), so there's no equivalent
        // of tool:result:partial to surface, only the final result.
        let out: unknown
        if (typeof (executed as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
          for await (const value of executed as AsyncIterable<unknown>) out = value
        } else {
          out = await executed
        }
        return toStructured(out, outputWrapped)
      },
    )
  }

  return server
}

// Connection-pinned dual-era stdio serving: the SDK negotiates 2025-11-25 vs
// 2026-07-28 on the opening exchange of *each* connection and pins the
// factory-built server to whichever era won — unlike v1's single
// `server.connect(transport)`, the factory must be able to build a fresh
// `McpServer` per connection.
export async function serveStdio(bread: McpBread, expose: ExposeConfig): Promise<void> {
  await sdkServeStdio(() => buildMcpServer(bread, expose))
}

// Build the HTTP handler once (not per request): `createMcpHandler`'s
// `legacy: 'stateless'` default serves 2026-07-28 natively and falls back to
// the same per-request-fresh-transport idiom bread already used for
// 2025-11-25 — one handler, one endpoint, both eras, still no session state.
export function buildMcpHttpHandler(bread: McpBread, expose: ExposeConfig): McpHttpHandler {
  return createMcpHandler(() => buildMcpServer(bread, expose), { legacy: 'stateless' })
}
