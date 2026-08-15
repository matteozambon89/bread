import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { BreadError, assertName } from '@bread/core'
import type { BreadSigner, ToolDefinition } from '@bread/core'
import { type JSONSchema, jsonSchemaToZod } from './json-schema-to-zod.js'

export interface McpServerConfig {
  name: string
  transport?: 'stdio' | 'http'
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http (streamable HTTP, falling back to legacy SSE)
  url?: string
  /** Signer used to sign outgoing requests (HTTP transport). */
  signer?: BreadSigner
}

export interface ConnectedServer {
  name: string
  client: Client
  tools: ToolDefinition[]
  close(): Promise<void>
}

function flattenContent(res: { content?: unknown; isError?: boolean }): unknown {
  const content = res.content
  if (!Array.isArray(content)) return res
  const texts = content
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
    .map((c) => c.text)
  if (res.isError) return { error: texts.join('\n') || 'MCP tool error' }
  if (texts.length === 1) return texts[0]
  if (texts.length > 1) return texts.join('\n')
  return content
}

// Signing happens per request (not once at connect) so strategies with
// expiring credentials — oauth2's cached token above all — re-sign naturally:
// each call goes through the strategy, which refreshes when its cache lapses.
function signingFetch(
  signer: BreadSigner | undefined,
): ((url: string | URL, init?: RequestInit) => Promise<Response>) | undefined {
  if (!signer) return undefined
  return async (url, init) => {
    const headers = new Headers(init?.headers)
    await signer.sign(headers)
    return fetch(url, { ...init, headers })
  }
}

/**
 * External servers name tools however they like (`list-files`, `readFile`,
 * `fs.read`); bread's naming convention is strict snake_case. Sanitize the
 * bread-facing name and keep the original for `callTool` — rejecting would
 * take down every tool on the server over one incompatible name.
 */
export function sanitizeMcpToolName(original: string): string {
  const name = original
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[a-z]/.test(name) ? name : `t_${name}`
}

async function fetchTools(cfg: McpServerConfig, client: Client): Promise<ToolDefinition[]> {
  const { tools: mcpTools } = await client.listTools()
  const seen = new Map<string, string>() // sanitized → original
  return mcpTools.map((t) => {
    const name = sanitizeMcpToolName(t.name)
    assertName('mcp tool', name) // backstop; the sanitizer should always satisfy it
    const clash = seen.get(name)
    if (clash !== undefined && clash !== t.name) {
      throw new BreadError(
        `mcp server "${cfg.name}": tools "${clash}" and "${t.name}" both sanitize to "${name}" — rename one on the server`,
        'TOOL_NAME_COLLISION',
        { server: cfg.name, sanitized: name, originals: [clash, t.name] },
      )
    }
    seen.set(name, t.name)
    const description = t.description ?? t.name
    return {
      name,
      description: name === t.name ? description : `${description} (server tool "${t.name}")`,
      schema: jsonSchemaToZod(t.inputSchema as JSONSchema),
      async execute(args: unknown) {
        const res = await client.callTool({
          name: t.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        })
        return flattenContent(res as { content?: unknown; isError?: boolean })
      },
    }
  })
}

async function finishConnect(cfg: McpServerConfig, client: Client): Promise<ConnectedServer> {
  const server: ConnectedServer = {
    name: cfg.name,
    client,
    tools: await fetchTools(cfg, client),
    close: () => client.close(),
  }

  // resolveAgentTools re-reads `server.tools` on every run (see
  // mcp-client's README/docs/mcp-client.md), so keeping this array current is
  // enough — no polling, no core changes needed.
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      server.tools = await fetchTools(cfg, client)
    } catch (err) {
      console.warn(`[bread] mcp_client: failed to refresh tools for server "${cfg.name}" after list_changed:`, err)
    }
  })

  return server
}

// A 4xx from the Streamable HTTP transport means "this server doesn't speak
// Streamable HTTP" (wrong endpoint shape, method not allowed, etc.) — the
// SDK's own documented recovery is to retry the same URL over the legacy SSE
// transport. Anything else (network failure, 5xx) is a real error and should
// not be masked by a fallback attempt.
function isLikelyStreamableHttpUnsupported(err: unknown): boolean {
  return err instanceof StreamableHTTPError && typeof err.code === 'number' && err.code >= 400 && err.code < 500
}

// Connect to one external MCP server and translate its tools into bread tools.
export async function connectServer(cfg: McpServerConfig): Promise<ConnectedServer> {
  assertName('mcp server', cfg.name)

  if (cfg.transport === 'http' || cfg.url) {
    if (!cfg.url) throw new Error(`mcp server "${cfg.name}": http transport requires a url`)
    const fetchImpl = signingFetch(cfg.signer)
    const client = new Client({ name: `bread-mcp:${cfg.name}`, version: '0.1.0' })
    try {
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      })
      // SDK transport types clash with exactOptionalPropertyTypes; safe at runtime.
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
      return finishConnect(cfg, client)
    } catch (err) {
      if (!isLikelyStreamableHttpUnsupported(err)) throw err
      // Legacy fallback: a failed connect() poisons the original client, so
      // use a fresh one, on the same URL, over SSE.
      const legacyClient = new Client({ name: `bread-mcp:${cfg.name}`, version: '0.1.0' })
      const sseTransport = new SSEClientTransport(new URL(cfg.url), {
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      })
      await legacyClient.connect(sseTransport)
      return finishConnect(cfg, legacyClient)
    }
  }

  if (!cfg.command) throw new Error(`mcp server "${cfg.name}": stdio transport requires a command`)
  const client = new Client({ name: `bread-mcp:${cfg.name}`, version: '0.1.0' })
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    ...(cfg.env ? { env: cfg.env } : {}),
  })
  await client.connect(transport)
  return finishConnect(cfg, client)
}
