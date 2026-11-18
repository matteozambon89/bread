import { expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import { mysqlConfig } from '../src/connect.ts'
import { store } from '../src/store.ts'

const PASSWORD = 's3cret-placeholder'

function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return ''
  const cause = err.cause instanceof Error ? err.cause.message : ''
  return `${err.message}\n${cause}`
}

test('a missing URL names MYSQL_URL and does not read another variable', () => {
  const previous = process.env.MYSQL_URL
  process.env.MYSQL_URL = ''
  try {
    expect(() => store()).toThrow(BreadError)
    try {
      store()
    } catch (err) {
      expect(err).toMatchObject({ code: 'MYSQL_URL_MISSING' })
      expect(messageOf(err)).not.toContain(PASSWORD)
      expect(messageOf(err)).toContain('MYSQL_URL')
    }
  } finally {
    if (previous === undefined) delete process.env.MYSQL_URL
    else process.env.MYSQL_URL = previous
  }
})

test('cleartext to a remote host is rejected and the password stays out of the error', () => {
  expect(() => store({ url: `mysql://app:${PASSWORD}@db.example:3306/bread` })).toThrow(BreadError)
  try {
    store({ url: `mysql://app:${PASSWORD}@db.example:3306/bread` })
  } catch (err) {
    expect(err).toMatchObject({ code: 'MYSQL_TLS_REQUIRED' })
    expect(messageOf(err)).not.toContain(PASSWORD)
    expect(messageOf(err)).not.toContain('db.example')
  }
})

test('loopback does not exempt a host that is not loopback', () => {
  expect(() =>
    store({ url: `mysql://app:${PASSWORD}@127.1:3306/bread`, loopback: true }),
  ).toThrow(BreadError)
  try {
    store({ url: `mysql://app:${PASSWORD}@127.1:3306/bread`, loopback: true })
  } catch (err) {
    expect((err as BreadError).code).toBe('MYSQL_TLS_REQUIRED')
    expect(messageOf(err)).not.toContain(PASSWORD)
  }
})

test('cleartext loopback without the option is rejected', () => {
  expect(() => store({ url: 'mysql://app:placeholder@127.0.0.1:3306/bread' })).toThrow(BreadError)
})

test('a query string is rejected', () => {
  expect(() => store({ url: 'mysqls://app:placeholder@db.example:3306/bread?ssl-mode=DISABLED' })).toThrow(
    BreadError,
  )
  try {
    store({ url: 'mysql://app:placeholder@127.0.0.1:3306/bread?localInfile=true', loopback: true })
  } catch (err) {
    expect((err as BreadError).code).toBe('MYSQL_URL_INVALID')
  }
})

test('a remote userless URL is rejected', () => {
  try {
    store({ url: 'mysqls://db.example:3306/bread' })
    throw new Error('expected auth failure')
  } catch (err) {
    expect((err as BreadError).code).toBe('MYSQL_AUTH_REQUIRED')
  }
})

test('verified TLS is on for mysqls and cleartext loopback keeps statements and infile off', () => {
  const remote = mysqlConfig({ url: 'mysqls://app:placeholder@db.example:3306/bread' })
  expect(remote.multipleStatements).toBe(false)
  expect(remote.flags).toEqual(['-LOCAL_FILES'])
  expect(remote.infileStreamFactory).toBeUndefined()
  expect(remote.namedPlaceholders).toBe(false)
  expect(remote.ssl).toMatchObject({ rejectUnauthorized: true, minVersion: 'TLSv1.2' })
  expect(remote).not.toHaveProperty('uri')
  expect(remote.socketPath).toBeUndefined()

  const local = mysqlConfig({ url: 'mysql://app:placeholder@127.0.0.1:3306/bread', loopback: true })
  expect(local.host).toBe('127.0.0.1')
  expect(local.ssl).toBeUndefined()
  expect(local.multipleStatements).toBe(false)
  expect(local.flags).toEqual(['-LOCAL_FILES'])

  const v6 = mysqlConfig({ url: 'mysql://app:placeholder@[::1]:3306/bread', loopback: true })
  expect(v6.host).toBe('::1')
  expect(v6.ssl).toBeUndefined()
})

test('a bad tag key or limit fails before a connection', async () => {
  const backend = store({ url: 'mysql://app:placeholder@127.0.0.1:1/bread', loopback: true })
  try {
    await expect(backend.createSession({ tags: { 'a.b': 'x' } })).rejects.toMatchObject({ code: 'INVALID_TAG' })
    await expect(backend.createSession({ tags: { $where: 'x' } })).rejects.toMatchObject({ code: 'INVALID_TAG' })
    await expect(
      backend.addMemory?.({
        agentId: 'a',
        principal: { iss: { $gt: '' } as unknown as string, sub: 's' },
        content: 'c',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PRINCIPAL' })
    await expect(
      backend.searchDocuments?.({ agentId: 'a', query: 'x', limit: Number.POSITIVE_INFINITY }),
    ).rejects.toMatchObject({ code: 'INVALID_LIMIT' })
  } finally {
    await backend.close?.()
  }
})
