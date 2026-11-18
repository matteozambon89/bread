import { expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import { store } from '@breadai/store-mongodb'

function dump(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current = err
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(current.name, current.message, current.stack ?? '')
      current = current.cause
      continue
    }
    break
  }
  return parts.join('\n')
}

test('a missing URL throws without a sample password', () => {
  const previous = process.env.MONGODB_URL
  delete process.env.MONGODB_URL
  try {
    expect(() => store()).toThrow(BreadError)
    try {
      store()
    } catch (err) {
      expect(err).toMatchObject({ code: 'STORE_URL_MISSING' })
      expect(dump(err)).not.toMatch(/user:pass|:[^@\s/]+@/)
    }
  } finally {
    if (previous === undefined) delete process.env.MONGODB_URL
    else process.env.MONGODB_URL = previous
  }
})

test('cleartext, invalid certificates, and a non-loopback host are rejected', () => {
  expect(() => store({ url: 'mongodb://example.com/bread' })).toThrow(BreadError)
  expect(() => store({ url: 'mongodb://127.0.0.1:27017/bread' })).toThrow(BreadError)
  expect(() => store({ url: 'mongodb://user:secret@example.com/bread?tls=true&tlsAllowInvalidCertificates=true' })).toThrow(
    BreadError,
  )
  expect(() => store({ url: 'mongodb://user:secret@example.com/bread', loopback: true })).toThrow(BreadError)
  expect(() => store({ url: 'mongodb+srv://cluster.example.com/bread' })).toThrow(BreadError)
  expect(() => store({ url: 'mongodb+srv://user:secret@cluster.example.com/bread?tls=false' })).toThrow(BreadError)
  for (const url of [
    'mongodb://example.com/bread',
    'mongodb://user:secret@example.com/bread?tls=true&tlsAllowInvalidCertificates=true',
    'mongodb://user:secret@example.com/bread',
  ]) {
    try {
      store({ url })
    } catch (err) {
      expect(dump(err)).not.toContain('secret')
      expect(err).toMatchObject({ code: 'STORE_URL_REJECTED' })
    }
  }
})

test('verified TLS with credentials is accepted, and loopback cleartext needs the option', async () => {
  const remote = store({ url: 'mongodb://user:secret@example.com/bread?tls=true' })
  await remote.close?.()
  const local = store({ url: 'mongodb://127.0.0.1:27017/bread', loopback: true })
  await local.close?.()
  const v6 = store({ url: 'mongodb://[::1]:27017/bread', loopback: true })
  await v6.close?.()
  const both = store({ url: 'mongodb://127.0.0.1:27017,localhost:27018/bread', loopback: true })
  await both.close?.()
  const srv = store({ url: 'mongodb+srv://user:secret@cluster.example.com/bread' })
  await srv.close?.()
  expect(() => store({ url: 'mongodb://127.0.0.1:27017', loopback: true })).toThrow(BreadError)
  expect(() => store({ url: 'mongodb://127.0.0.1:27017,example.com:27017/bread', loopback: true })).toThrow(BreadError)
})

test('a refused loopback connection does not keep the password', async () => {
  const opened = store({ url: 'mongodb://user:secret@127.0.0.1:1/bread', loopback: true })
  try {
    await opened.migrate?.()
    throw new Error('expected the migration lock to fail')
  } catch (err) {
    expect(dump(err)).not.toContain('secret')
    expect(err).toMatchObject({ code: 'MIGRATION_LOCK' })
  } finally {
    await opened.close?.()
  }
}, 20_000)
