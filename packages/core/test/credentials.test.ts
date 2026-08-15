import { afterEach, describe, expect, test } from 'bun:test'
import { BreadError, envProvider, vaultProvider } from '@breadai/core'

describe('envProvider', () => {
  afterEach(() => {
    delete process.env.BREAD_TEST_SECRET
  })

  test('reads a value from the environment', async () => {
    process.env.BREAD_TEST_SECRET = 's3cr3t'
    expect(await envProvider().get('BREAD_TEST_SECRET')).toBe('s3cr3t')
  })

  test('returns undefined for an unset name', async () => {
    expect(await envProvider().get('BREAD_TEST_MISSING')).toBeUndefined()
  })
})

describe('vaultProvider', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('reads a secret from the vault HTTP API', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain('/v1/secret/data/api-key')
      return new Response(JSON.stringify({ data: { data: { 'api-key': 'abc123' } } }), {
        status: 200,
      })
    }) as typeof fetch

    const provider = vaultProvider({ address: 'https://vault.local', token: 't' })
    expect(await provider.get('api-key')).toBe('abc123')
  })

  test('returns undefined on a non-ok response', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch
    const provider = vaultProvider({ address: 'https://vault.local', token: 't' })
    expect(await provider.get('missing')).toBeUndefined()
  })

  test('rejects a mount containing unsafe path characters at construction time', () => {
    expect(() => vaultProvider({ address: 'https://vault.local', token: 't', mount: '../other' })).toThrow(
      BreadError,
    )
  })

  test.each([['../other-mount/x'], ['name?x=1'], ['name#frag'], ['has space'], ['has/slash'], ['']])(
    'rejects credential name "%s"',
    async (name) => {
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        return new Response('should not be reached', { status: 200 })
      }) as typeof fetch
      const provider = vaultProvider({ address: 'https://vault.local', token: 't' })
      await expect(provider.get(name)).rejects.toThrow(BreadError)
      expect(fetchCalled).toBe(false)
    },
  )

  test('throws INVALID_CREDENTIAL_NAME with kind/value context for an unsafe name', async () => {
    const provider = vaultProvider({ address: 'https://vault.local', token: 't' })
    try {
      await provider.get('../escape')
      throw new Error('expected vaultProvider.get to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      const e = err as BreadError
      expect(e.code).toBe('INVALID_CREDENTIAL_NAME')
      expect(e.context).toEqual({ kind: 'credential name', value: '../escape' })
    }
  })

  test('throws INVALID_VAULT_MOUNT with kind/value context for an unsafe mount', () => {
    try {
      vaultProvider({ address: 'https://vault.local', token: 't', mount: '../evil' })
      throw new Error('expected vaultProvider to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      const e = err as BreadError
      expect(e.code).toBe('INVALID_VAULT_MOUNT')
      expect(e.context).toEqual({ kind: 'vault mount', value: '../evil' })
    }
  })
})
