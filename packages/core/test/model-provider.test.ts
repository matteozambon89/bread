import { describe, expect, test } from 'bun:test'
import { resolveModel } from '@breadai/core'
import { mockTextModel } from '@breadai/test-utils'

describe('resolveModel', () => {
  test('resolves a provider registered in a passed registry', async () => {
    const model = mockTextModel('hi')
    const resolved = await resolveModel({ provider: 'mock', model: 'x' }, [{ mock: () => model }])
    expect(resolved).toBe(model)
  })

  test('the first registry wins on a name collision (agent → global order)', async () => {
    const agentModel = mockTextModel('agent')
    const globalModel = mockTextModel('global')
    const resolved = await resolveModel({ provider: 'mock', model: 'x' }, [
      { mock: () => agentModel },
      { mock: () => globalModel },
    ])
    expect(resolved).toBe(agentModel)
  })

  test('falls through to a later registry when an earlier one lacks the name', async () => {
    const globalModel = mockTextModel('global')
    const resolved = await resolveModel({ provider: 'mock', model: 'x' }, [
      { other: () => mockTextModel('unused') },
      { mock: () => globalModel },
    ])
    expect(resolved).toBe(globalModel)
  })

  test('supports an async factory (e.g. a lazily-imported provider)', async () => {
    const model = mockTextModel('async')
    const resolved = await resolveModel({ provider: 'mock', model: 'x' }, [{ mock: async () => model }])
    expect(resolved).toBe(model)
  })

  test('throws UNKNOWN_PROVIDER naming the registered providers when nothing matches', async () => {
    const err = await resolveModel({ provider: 'nope', model: 'x' }, [
      { mock: () => mockTextModel('hi') },
    ]).catch((e) => e)
    expect(err.code).toBe('UNKNOWN_PROVIDER')
    expect(err.message).toContain('mock')
  })

  test('throws UNKNOWN_PROVIDER when no registries are passed at all', async () => {
    await expect(resolveModel({ provider: 'nope', model: 'x' })).rejects.toMatchObject({
      code: 'UNKNOWN_PROVIDER',
    })
  })
})
