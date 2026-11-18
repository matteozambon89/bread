import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'
import { mysqlConfig, type MysqlStoreOptions } from '../src/connect.ts'

function ensureDockerHost(): void {
  if (typeof process.env.DOCKER_HOST === 'string' && process.env.DOCKER_HOST !== '') return
  const socket = [
    '/var/run/docker.sock',
    join(homedir(), '.docker', 'run', 'docker.sock'),
    join(homedir(), '.docker', 'desktop', 'docker.sock'),
    join(homedir(), '.colima', 'default', 'docker.sock'),
  ].find((path) => existsSync(path))
  if (!socket) return
  process.env.DOCKER_HOST = `unix://${socket}`
  // Colima's host socket is not the path inside the VM. Ryuk mounts the VM path.
  if (socket.includes('/.colima/') && process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE === undefined) {
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock'
  }
}

const TEST_USER = 'bread'
const TEST_PASSWORD = 'bread-test'
const TEST_ROOT_PASSWORD = 'bread-root'
const TEST_DATABASE = 'bread'

const DATA_TABLES = [
  'bread_session_messages',
  'bread_checkpoints',
  'bread_crumbs',
  'bread_loop_iterations',
  'bread_loops',
  'bread_memories',
  'bread_documents',
  'bread_task_runs',
  'bread_sessions',
] as const

const ALL_TABLES = [...DATA_TABLES, 'bread_migrations', 'bread_kg_nodes', 'bread_kg_edges'] as const

export interface MysqlFixture {
  opts: MysqlStoreOptions
  stop(): Promise<void>
  reset(): Promise<void>
  drop(): Promise<void>
  query(text: string, params?: Array<string | number | null>): Promise<RowDataPacket[]>
  ddl(text: string): Promise<void>
}

export async function startMysql(): Promise<MysqlFixture> {
  const fromEnv = process.env.MYSQL_URL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return openFixture({ url: fromEnv, loopback: true }, async () => {})
  }
  ensureDockerHost()
  let container: StartedMySqlContainer
  try {
    container = await new MySqlContainer('mysql:8')
      .withDatabase(TEST_DATABASE)
      .withUsername(TEST_USER)
      .withUserPassword(TEST_PASSWORD)
      .withRootPassword(TEST_ROOT_PASSWORD)
      .start()
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Error'
    const safe = reason
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1')
      .replaceAll(TEST_PASSWORD, '')
      .replaceAll(TEST_ROOT_PASSWORD, '')
    throw new Error(
      `MySQL did not start. Start Docker or set MYSQL_URL to a disposable local server. ${safe.slice(0, 180)}`,
    )
  }
  const port = container.getMappedPort(3306)
  const url = `mysql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DATABASE}`
  return openFixture({ url, loopback: true }, async () => {
    await container.stop()
  })
}

async function openFixture(opts: MysqlStoreOptions, stop: () => Promise<void>): Promise<MysqlFixture> {
  const pool = createPool(mysqlConfig(opts))
  return {
    opts,
    stop: async () => {
      await pool.end()
      await stop()
    },
    reset: () => truncate(pool),
    drop: () => dropAll(pool),
    query: async (text, params = []) => {
      const [rows] = await pool.execute<RowDataPacket[]>(text, params)
      return rows
    },
    ddl: async (text) => {
      await pool.query(text)
    },
  }
}

async function withSession(pool: Pool, fn: (conn: Awaited<ReturnType<Pool['getConnection']>>) => Promise<void>): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await fn(conn)
  } finally {
    conn.release()
  }
}

async function truncate(pool: Pool): Promise<void> {
  await withSession(pool, async (conn) => {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of DATA_TABLES) await conn.query(`TRUNCATE TABLE \`${table}\``)
    await conn.query('SET FOREIGN_KEY_CHECKS = 1')
  })
}

async function dropAll(pool: Pool): Promise<void> {
  await withSession(pool, async (conn) => {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of ALL_TABLES) await conn.query(`DROP TABLE IF EXISTS \`${table}\``)
    await conn.query('SET FOREIGN_KEY_CHECKS = 1')
  })
}
