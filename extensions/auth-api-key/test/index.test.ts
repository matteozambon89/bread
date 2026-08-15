import { describe, expect, test } from 'bun:test'
import { authStrategy, signer } from '@breadai/auth-api-key'

function reqWith(headers: Record<string, string>): Request {
  return new Request('http://x/agents', { headers })
}

describe('api-key auth strategy', () => {
  test('accepts a request bearing a configured key', async () => {
    const strat = authStrategy({ keys: ['k1', 'k2'], header: 'x-api-key' })
    expect(await strat.authenticate(reqWith({ 'x-api-key': 'k2' }))).toMatchObject({
      subject: 'api-key',
    })
  })

  test('rejects an unknown key', async () => {
    const strat = authStrategy({ keys: ['k1'], header: 'x-api-key' })
    expect(await strat.authenticate(reqWith({ 'x-api-key': 'nope' }))).toBeNull()
  })

  test('rejects a missing header', async () => {
    const strat = authStrategy({ keys: ['k1'], header: 'x-api-key' })
    expect(await strat.authenticate(reqWith({}))).toBeNull()
  })

  test('honours a scheme prefix', async () => {
    const strat = authStrategy({ keys: ['secret'], scheme: 'Bearer' })
    expect(await strat.authenticate(reqWith({ authorization: 'Bearer secret' }))).toMatchObject({
      subject: 'api-key',
    })
    // A raw key without the scheme prefix must not authenticate.
    expect(await strat.authenticate(reqWith({ authorization: 'secret' }))).toBeNull()
  })
})

describe('api-key signer', () => {
  test('attaches the first available key, honouring a scheme prefix', async () => {
    const sign = signer({ keys: ['secret'], scheme: 'Bearer' })
    const headers = new Headers()
    await sign.sign(headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
  })

  test('throws when no key is available to attach', () => {
    const sign = signer({})
    expect(sign.sign(new Headers())).rejects.toThrow(/no key available/)
  })
})
