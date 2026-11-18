import { BreadError, isLoopbackHostname } from '@breadai/core'
import sql, { type config as MssqlConfig } from 'mssql'

export interface MssqlStoreOptions {
  /** Connection string. Defaults to `MSSQL_URL`. Encrypt and trust flags in the string are ignored. */
  url?: string
  /**
   * When true, trust the server certificate only if `isLoopbackHostname` accepts the host.
   * Any other host is rejected. Omit it and `trustServerCertificate` stays false. `encrypt` stays true.
   */
  loopback?: boolean
}

interface ParsedConnection {
  host: string
  port: number
  database: string
  user: string
  password: string
}

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
const USER_NAME = /^[A-Za-z0-9_.\\@-]{1,128}$/
const HOST_NAME = /^[A-Za-z0-9.-]+$/

function invalid(): never {
  throw new BreadError('SQL Server connection string is invalid.', 'STORE_CONFIG', {})
}

function normalizeHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

function validHost(host: string): boolean {
  if (host === '::1') return true
  if (host.includes(':') || host.length === 0 || host.length > 253) return false
  return HOST_NAME.test(host)
}

function portOrDefault(value: string | undefined): number {
  if (value === undefined || value === '') return 1433
  if (!/^\d+$/.test(value)) invalid()
  const port = Number(value)
  if (port < 1 || port > 65535) invalid()
  return port
}

function splitServer(server: string): { host: string; port?: number } {
  let value = server.trim()
  if (value.toLowerCase().startsWith('tcp:')) value = value.slice(4)
  const comma = value.lastIndexOf(',')
  if (comma > 0 && /^\d+$/.test(value.slice(comma + 1))) {
    return { host: normalizeHost(value.slice(0, comma)), port: portOrDefault(value.slice(comma + 1)) }
  }
  return { host: normalizeHost(value) }
}

function rejectAuthMode(entries: Map<string, string>): void {
  const integrated = entries.get('integrated security') ?? entries.get('trusted_connection')
  if (integrated !== undefined && /^(true|yes|sspi)$/i.test(integrated)) {
    throw new BreadError('SQL Server integrated security is not supported.', 'STORE_CONFIG', {})
  }
  if (entries.has('authentication')) {
    throw new BreadError('SQL Server authentication mode is not supported.', 'STORE_CONFIG', {})
  }
}

function finish(parsed: ParsedConnection, loopback: boolean | undefined): MssqlConfig {
  if (!validHost(parsed.host)) invalid()
  if (!DATABASE_NAME.test(parsed.database) || !USER_NAME.test(parsed.user)) invalid()
  if (parsed.password.length === 0 || parsed.password.length > 128) {
    throw new BreadError('SQL Server user and password are required.', 'STORE_CONFIG', {})
  }
  if (loopback === true && !isLoopbackHostname(parsed.host)) {
    throw new BreadError('loopback is only valid for a loopback host.', 'STORE_CONFIG', {})
  }
  const trustServerCertificate = loopback === true && isLoopbackHostname(parsed.host)
  return {
    server: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
    options: {
      encrypt: true,
      trustServerCertificate,
      enableArithAbort: true,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 10_000 },
  }
}

function parseUrl(value: string): ParsedConnection {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid()
  }
  if (url.protocol !== 'mssql:' && url.protocol !== 'sqlserver:') invalid()
  let user = ''
  let password = ''
  try {
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    invalid()
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (user === '' || password === '' || database === '') {
    throw new BreadError('SQL Server user and password are required.', 'STORE_CONFIG', {})
  }
  return { host: normalizeHost(url.hostname), port: portOrDefault(url.port), database, user, password }
}

function parseAdo(value: string): ParsedConnection {
  const entries = new Map<string, string>()
  for (const part of value.split(';')) {
    if (part.trim() === '') continue
    const eq = part.indexOf('=')
    if (eq <= 0) invalid()
    entries.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim())
  }
  rejectAuthMode(entries)
  const server = entries.get('server') ?? entries.get('data source') ?? entries.get('address') ?? entries.get('addr') ?? entries.get('network address')
  const database = entries.get('database') ?? entries.get('initial catalog')
  const user = entries.get('user id') ?? entries.get('uid') ?? entries.get('user')
  const password = entries.get('password') ?? entries.get('pwd')
  if (!server || !database || !user || password === undefined) {
    throw new BreadError('SQL Server user and password are required.', 'STORE_CONFIG', {})
  }
  const split = splitServer(server)
  const port = split.port ?? portOrDefault(entries.get('port'))
  return { host: split.host, port, database, user, password }
}

export function resolveMssqlConfig(opts: MssqlStoreOptions = {}): MssqlConfig {
  const url = opts.url ?? process.env.MSSQL_URL
  if (typeof url !== 'string' || url.trim() === '') {
    throw new BreadError(
      'store: no connection string. Pass `url` or set MSSQL_URL (e.g. mssql://<host>:1433/<db>).',
      'STORE_CONFIG',
      {},
    )
  }
  const trimmed = url.trim()
  const parsed = trimmed.includes('://') ? parseUrl(trimmed) : parseAdo(trimmed)
  return finish(parsed, opts.loopback)
}

export function mssqlPool(config: MssqlConfig): sql.ConnectionPool {
  return new sql.ConnectionPool(config)
}
