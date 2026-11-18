import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { BreadError, redactConnectionSecrets, redactError } from '@breadai/core'

export type Sql = Pool | PoolConnection
export type SqlValue = string | number | null

export function rethrow(err: unknown): never {
  if (err instanceof BreadError) {
    throw new BreadError(redactConnectionSecrets(err.message), err.code, err.context, redactError(err.cause))
  }
  const redacted = redactError(err)
  if (redacted instanceof Error) throw redacted
  throw new Error('Query failed.')
}

export function errno(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('errno' in err)) return undefined
  const value = (err as { errno: unknown }).errno
  return typeof value === 'number' ? value : undefined
}

export function sqlCode(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return ''
  const value = (err as { code: unknown }).code
  return typeof value === 'string' ? value : ''
}

export async function selectRows<T extends RowDataPacket>(
  sql: Sql,
  text: string,
  params: readonly SqlValue[] = [],
): Promise<T[]> {
  const [rows] = await sql.execute<T[]>(text, params as SqlValue[])
  return rows
}

export async function executeSql(
  sql: Sql,
  text: string,
  params: readonly SqlValue[] = [],
): Promise<ResultSetHeader> {
  const [result] = await sql.execute<ResultSetHeader>(text, params as SqlValue[])
  return result
}

/** Static DDL only. Callers pass a constant statement, never input. */
export async function execStatic(sql: Sql, text: string): Promise<void> {
  await sql.query(text)
}

export async function withTransaction<T>(pool: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    try {
      await conn.rollback()
    } catch {
      // The original error is the one callers need.
    }
    throw err
  } finally {
    conn.release()
  }
}
