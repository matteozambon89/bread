import { createPool, type Pool, type PoolOptions } from 'mysql2/promise'
import { BreadError, isLoopbackHostname, redactError } from '@breadai/core'

export interface MysqlStoreOptions {
  /** Connection string. Defaults to `process.env.MYSQL_URL`. */
  url?: string
  /**
   * Allow cleartext and a missing user only when the host is loopback.
   * A remote host still requires verified TLS and a user.
   */
  loopback?: boolean
}

const DATABASE_NAME = /^[A-Za-z0-9_-]+$/

function fail(code: string, message: string, cause?: unknown): never {
  throw new BreadError(message, code, {}, cause === undefined ? undefined : redactError(cause))
}

function connectionString(opts: MysqlStoreOptions): string {
  const raw = opts.url ?? process.env.MYSQL_URL
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(
      'MYSQL_URL_MISSING',
      'store: no connection string. Pass `url` or set MYSQL_URL (for example mysql://<host>:3306/<db>).',
    )
  }
  return raw
}

function driverHost(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1)
  return hostname
}

/** Pool options from the store URL. Does not open a connection. */
export function mysqlConfig(opts: MysqlStoreOptions = {}): PoolOptions {
  const raw = connectionString(opts)
  let url: URL
  try {
    url = new URL(raw)
  } catch (err) {
    fail('MYSQL_URL_INVALID', 'store: MySQL connection string is invalid.', err)
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mysqls:') {
    fail('MYSQL_URL_INVALID', 'store: MySQL connection string is invalid.')
  }
  if (url.search !== '' || url.hash !== '') {
    fail('MYSQL_URL_INVALID', 'store: MySQL connection string is invalid.')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!DATABASE_NAME.test(database)) {
    fail('MYSQL_URL_INVALID', 'store: MySQL database name is invalid.')
  }
  const host = driverHost(url.hostname)
  if (host === '') fail('MYSQL_URL_INVALID', 'store: MySQL connection string is invalid.')
  const port = url.port === '' ? 3306 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('MYSQL_URL_INVALID', 'store: MySQL connection string is invalid.')
  }
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const loopback = opts.loopback === true && isLoopbackHostname(url.hostname)
  const tls = url.protocol === 'mysqls:'
  if (!tls && !loopback) fail('MYSQL_TLS_REQUIRED', 'store: MySQL requires verified TLS.')
  if (user === '' && !loopback) fail('MYSQL_AUTH_REQUIRED', 'store: MySQL requires a user.')

  const config: PoolOptions = {
    host,
    port,
    user,
    password,
    database,
    charset: 'utf8mb4',
    connectTimeout: 10_000,
    connectionLimit: 8,
    waitForConnections: true,
    enableKeepAlive: true,
    multipleStatements: false,
    namedPlaceholders: false,
    // mysql2 enables LOCAL_FILES unless this flag is removed. It has no localInfile option.
    flags: ['-LOCAL_FILES'],
  }
  if (tls) {
    config.ssl = { rejectUnauthorized: true, minVersion: 'TLSv1.2' }
  }
  return config
}

export function mysqlPool(opts: MysqlStoreOptions = {}): Pool {
  return createPool(mysqlConfig(opts))
}
