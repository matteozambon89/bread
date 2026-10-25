// URLs are a reviewed pin of the official MCP registry
// (GET /v0.1/servers/{name}/versions/latest). The CLI does not fetch the
// registry. Only com.* servers whose response included a streamable-http
// remote are listed. Community namespaces are not. No content hash is stored.

export type McpAuthMode = 'none' | 'api_key' | 'oauth'

interface McpAllowlistBase {
  /** Short name passed to `bread mcp add`. */
  name: string
  /** Reverse-DNS namespace (the registry name before `/`). */
  namespace: string
  url: string
  /** Registry `version` string. Absent when the entry has none. */
  version?: string
}

export type McpAllowlistEntry =
  | (McpAllowlistBase & { auth: 'none' | 'oauth' })
  | (McpAllowlistBase & { auth: 'api_key'; header: string; scheme: string; credential: string })

// Registry server names, for the pin review:
// com.airtable/mcp, com.atlassian/atlassian-mcp-server, com.figma.mcp/mcp,
// com.neon/mcp, com.notion/mcp, com.paypal.mcp/mcp, com.stripe/mcp,
// com.supabase/mcp, com.webflow/mcp, com.workos/mcp, com.zapier/mcp.
// A secret remote header is api_key. A remote with no secret header is oauth.
// scheme is the value prefix. The credential stores the token only.
export const mcpAllowlist: readonly McpAllowlistEntry[] = [
  { name: 'airtable', namespace: 'com.airtable', url: 'https://mcp.airtable.com/mcp', auth: 'oauth', version: '0.1.0' },
  {
    name: 'atlassian',
    namespace: 'com.atlassian',
    url: 'https://mcp.atlassian.com/v2/mcp',
    auth: 'oauth',
    version: '2.0.0',
  },
  { name: 'figma', namespace: 'com.figma.mcp', url: 'https://mcp.figma.com/mcp', auth: 'oauth', version: '1.0.3' },
  {
    name: 'neon',
    namespace: 'com.neon',
    url: 'https://mcp.neon.tech/mcp',
    auth: 'api_key',
    version: '1.0.0',
    header: 'Authorization',
    scheme: 'Bearer',
    credential: 'neon_api_key',
  },
  { name: 'notion', namespace: 'com.notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', version: '1.0.1' },
  {
    name: 'paypal',
    namespace: 'com.paypal.mcp',
    url: 'https://mcp.paypal.com/mcp',
    auth: 'api_key',
    version: '1.0.0',
    header: 'Authorization',
    scheme: 'Bearer',
    credential: 'paypal_api_key',
  },
  { name: 'stripe', namespace: 'com.stripe', url: 'https://mcp.stripe.com', auth: 'oauth', version: '0.2.4' },
  { name: 'supabase', namespace: 'com.supabase', url: 'https://mcp.supabase.com/mcp', auth: 'oauth', version: '0.14.0' },
  { name: 'webflow', namespace: 'com.webflow', url: 'https://mcp.webflow.com/mcp', auth: 'oauth', version: '2.0.0' },
  { name: 'workos', namespace: 'com.workos', url: 'https://mcp.workos.com/mcp', auth: 'oauth', version: '1.0.0' },
  {
    name: 'zapier',
    namespace: 'com.zapier',
    url: 'https://mcp.zapier.com/api/v1/connect',
    auth: 'oauth',
    version: '1.0.1',
  },
]
