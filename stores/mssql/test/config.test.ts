import { expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import { assertPrincipal, assertTags, likeContains } from '../src/bind.ts'
import { resolveMssqlConfig } from '../src/config.ts'
import { redactDriver } from '../src/errors.ts'
import { journalFailure } from '../src/migrate.ts'

const SECRET = 's3cret-value-not-real'

function rendered(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return `${err.message}\n${rendered(err.cause)}`
}

test('store config requires a url or MSSQL_URL and does not read other env vars', () => {
  const key = 'MSSQL_URL'
  const had = Object.prototype.hasOwnProperty.call(process.env, key)
  const previous = process.env[key]
  delete process.env[key]
  try {
    expect(() => resolveMssqlConfig({})).toThrow(BreadError)
    try {
      resolveMssqlConfig({})
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('STORE_CONFIG')
      expect((err as BreadError).message).toContain('MSSQL_URL')
      expect((err as BreadError).message).not.toContain('user:pass')
    }
  } finally {
    if (had) process.env[key] = previous
    else delete process.env[key]
  }
})

test('encrypt stays on and trust stays off unless loopback is explicit', () => {
  const remote = resolveMssqlConfig({
    url: `mssql://sa:${SECRET}@db.example:1433/bread?encrypt=false&trustServerCertificate=true`,
  })
  expect(remote.options?.encrypt).toBe(true)
  expect(remote.options?.trustServerCertificate).toBe(false)
  expect(remote.options && 'rejectUnauthorized' in remote.options).toBe(false)
  expect(remote.server).toBe('db.example')
  expect(remote.port).toBe(1433)
  expect(remote.database).toBe('bread')
  if (remote.password !== SECRET) throw new Error('password was not preserved')

  const ado = resolveMssqlConfig({
    url: `Server=10.1.2.3,1433;Database=bread;User Id=sa;Password=${SECRET};Encrypt=false;TrustServerCertificate=true`,
  })
  expect(ado.options?.encrypt).toBe(true)
  expect(ado.options?.trustServerCertificate).toBe(false)
  expect(ado.server).toBe('10.1.2.3')
  if (ado.password !== SECRET) throw new Error('password was not preserved')

  for (const host of ['127.0.0.1', 'localhost']) {
    const local = resolveMssqlConfig({ url: `mssql://sa:${SECRET}@${host}:1433/bread`, loopback: true })
    expect(local.options?.trustServerCertificate).toBe(true)
    expect(local.options?.encrypt).toBe(true)
  }
  const v6 = resolveMssqlConfig({ url: `mssql://sa:${SECRET}@[::1]:1433/bread`, loopback: true })
  expect(v6.server).toBe('::1')
  expect(v6.options?.trustServerCertificate).toBe(true)
})

test('loopback on a non-loopback host fails without echoing the url', () => {
  const raw = `mssql://sa:${SECRET}@db.example:1433/bread`
  try {
    resolveMssqlConfig({ url: raw, loopback: true })
    throw new Error('expected STORE_CONFIG')
  } catch (err) {
    expect(err).toBeInstanceOf(BreadError)
    expect((err as BreadError).code).toBe('STORE_CONFIG')
    const text = rendered(err)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(raw)
    expect(text).not.toContain('db.example')
  }
})

test('integrated security and other auth modes are rejected', () => {
  expect(() =>
    resolveMssqlConfig({
      url: 'Server=127.0.0.1;Database=bread;Trusted_Connection=yes',
    }),
  ).toThrow(BreadError)
  try {
    resolveMssqlConfig({ url: `Server=127.0.0.1;Database=bread;User Id=sa;Password=${SECRET};Authentication=ActiveDirectoryIntegrated` })
    throw new Error('expected STORE_CONFIG')
  } catch (err) {
    expect((err as BreadError).code).toBe('STORE_CONFIG')
    expect(rendered(err)).not.toContain(SECRET)
  }
})

test('driver errors drop passwords before they can be attached', () => {
  const err = new Error(`Login failed Password=${SECRET}; Server=db mssql://sa:${SECRET}@127.0.0.1/bread`)
  const redacted = redactDriver(err)
  expect(redacted).toBeInstanceOf(Error)
  expect(rendered(redacted)).not.toContain(SECRET)
})

test('journal permission and missing-object errors stay closed', () => {
  const denied = journalFailure({ number: 229, message: `Password=${SECRET}` }, 'fallback', 'MIGRATION_FAILED')
  expect(denied.code).toBe('MIGRATION_JOURNAL_FORBIDDEN')
  expect(rendered(denied)).not.toContain(SECRET)
  const fromNumber = journalFailure({ number: 208, message: 'missing' }, 'fallback', 'MIGRATION_FAILED')
  expect(fromNumber.code).toBe('MIGRATION_JOURNAL_MISSING')
})

test('tag keys are an allowlist and like wildcards are escaped', () => {
  expect(assertTags({ env: 'test' })).toEqual({ env: 'test' })
  expect(assertTags(undefined)).toEqual({})
  for (const tags of [{ '$gt': '1' }, { 'a.b': 'c' }, { env: 1 as unknown as string }]) {
    try {
      assertTags(tags as Record<string, string>)
      throw new Error('expected INVALID_TAG')
    } catch (err) {
      expect((err as BreadError).code).toBe('INVALID_TAG')
      expect(rendered(err)).not.toContain('$gt')
      expect(rendered(err)).not.toContain('a.b')
    }
  }
  expect(assertPrincipal({ iss: 'https://idp.example', sub: 'ada', tenant: 'acme' })).toEqual({
    iss: 'https://idp.example',
    sub: 'ada',
  })
  expect(() => assertPrincipal({ iss: 'https://idp.example', sub: 1 as unknown as string })).toThrow(BreadError)
  expect(likeContains('100%_[a\\b')).toBe('%100\\%\\_\\[a\\\\b%')
})
