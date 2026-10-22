import { assertName, BreadError } from '@breadai/core'
import { type McpAllowlistEntry, type McpAuthMode, mcpAllowlist } from './mcp-allowlist.js'

export interface McpListOptions {
  /** Accepted for CLI consistency. Not read and not written. */
  cwd: string
  log?: (line: string) => void
}

export interface McpAddOptions {
  /** Accepted for CLI consistency. Not read and not written. */
  cwd: string
  /** Positional allowlist name. */
  name?: string
  url?: string
  /** `--name`, only with `--url`. */
  serverName?: string
  log?: (line: string) => void
}

export interface McpPrintEntry {
  name: string
  url: string
  auth: McpAuthMode
  header?: string
  /** Value prefix, such as `Bearer`. Not part of the stored credential. */
  scheme?: string
  credential?: string
}

function writeLine(log: ((line: string) => void) | undefined, line: string): void {
  if (log) log(line)
  else console.log(line)
}

function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function signedHeaderSource(scheme: string): string {
  const escaped = scheme.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  return `\`${escaped} \${secret}\``
}

// The pasted object closes over this binding. bread.config.ts has no `credentials` in scope.
const API_KEY_PREAMBLE = "import { envProvider } from '@breadai/core'\nconst mcpCredentials = envProvider()"

export function renderMcpServerEntry(entry: McpPrintEntry, askWrites: boolean): string {
  const lines = ['{', `  name: ${tsString(entry.name)},`, `  transport: 'http',`, `  url: ${tsString(entry.url)},`]
  if (askWrites) lines.push('  askWrites: true,')
  if (entry.auth === 'api_key') {
    if (!entry.header || !entry.credential || !entry.scheme) {
      throw new BreadError(
        `MCP connector "${entry.name}" is api_key without a pinned header, credential, and scheme`,
        'MCP_CONNECTOR_AUTH',
        { name: entry.name },
      )
    }
    // PayPal's pin is `Authorization: Bearer <token>`; Neon is a Bearer API key.
    // A missing credential throws so the header is not silently dropped.
    lines.push(
      '  signer: {',
      `    name: ${tsString(entry.credential)},`,
      '    async sign(headers) {',
      `      const secret = await mcpCredentials.get(${tsString(entry.credential)})`,
      `      if (!secret) throw new Error(${tsString(`Missing credential ${entry.credential}`)})`,
      `      headers.set(${tsString(entry.header)}, ${signedHeaderSource(entry.scheme)})`,
      '    },',
      '  },',
    )
  }
  lines.push('}')
  const object = lines.join('\n')
  if (entry.auth !== 'api_key') return object
  return `${API_KEY_PREAMBLE}\n${object}`
}

function findConnector(name: string): McpAllowlistEntry | undefined {
  return mcpAllowlist.find((entry) => entry.name === name)
}

function printEntry(
  log: ((line: string) => void) | undefined,
  entry: McpPrintEntry,
  askWrites: boolean,
): void {
  writeLine(
    log,
    entry.auth === 'api_key'
      ? '[bread] Paste the import and const into bread.config.ts and the object into mcpClient({ servers }). Nothing was written.'
      : '[bread] Paste this server into mcpClient({ servers }) in bread.config.ts. Nothing was written.',
  )
  if (entry.auth === 'oauth') {
    writeLine(log, 'Per-user OAuth is not available in this command. It waits on issue #41.')
  }
  for (const line of renderMcpServerEntry(entry, askWrites).split('\n')) writeLine(log, line)
}

export async function runMcpList(opts: McpListOptions): Promise<void> {
  void opts.cwd
  const log = (line: string): void => writeLine(opts.log, line)
  const nameWidth = Math.max(...mcpAllowlist.map((entry) => entry.name.length))
  const namespaceWidth = Math.max(...mcpAllowlist.map((entry) => entry.namespace.length))
  const urlWidth = Math.max(...mcpAllowlist.map((entry) => entry.url.length))
  const authWidth = Math.max(...mcpAllowlist.map((entry) => entry.auth.length))

  log('[bread] Allowlisted MCP connectors')
  for (const entry of mcpAllowlist) {
    const version = entry.version ?? ''
    log(
      `  ${entry.name.padEnd(nameWidth)}  ${entry.namespace.padEnd(namespaceWidth)}  ${entry.url.padEnd(urlWidth)}  ${entry.auth.padEnd(authWidth)}  ${version}`.trimEnd(),
    )
  }
}

export async function runMcpAdd(opts: McpAddOptions): Promise<void> {
  void opts.cwd
  const positional = opts.name
  const url = opts.url
  if (opts.serverName !== undefined) {
    assertName('mcp server', opts.serverName)
    if (url === undefined) {
      throw new BreadError('`--name` requires `--url`.', 'MCP_NAME_REQUIRES_URL', { name: opts.serverName })
    }
  }
  if (positional !== undefined && url !== undefined) {
    throw new BreadError(
      'Pass an allowlist name or --url, not both.',
      'MCP_ADD_EXCLUSIVE',
      { name: positional, url },
    )
  }
  if (url !== undefined && opts.serverName === undefined) {
    throw new BreadError('`--url` requires `--name`.', 'MCP_NAME_REQUIRED', { url })
  }
  if (positional === undefined && url === undefined) {
    throw new BreadError(
      'Pass an allowlist name or `--url` with `--name`.',
      'MCP_ADD_TARGET_REQUIRED',
      {},
    )
  }

  const log = (line: string): void => writeLine(opts.log, line)

  if (url !== undefined) {
    const name = opts.serverName as string
    assertName('mcp server', name)
    printEntry(log, { name, url, auth: 'none' }, false)
    return
  }

  const name = positional as string
  assertName('mcp connector', name)
  const entry = findConnector(name)
  if (!entry) {
    const available = mcpAllowlist.map((item) => item.name).join(', ')
    throw new BreadError(`Unknown MCP connector "${name}". Available: ${available}`, 'UNKNOWN_MCP_CONNECTOR', {
      name,
      available: mcpAllowlist.map((item) => item.name),
    })
  }
  printEntry(
    log,
    {
      name: entry.name,
      url: entry.url,
      auth: entry.auth,
      ...(entry.auth === 'api_key'
        ? { header: entry.header, scheme: entry.scheme, credential: entry.credential }
        : {}),
    },
    true,
  )
}
