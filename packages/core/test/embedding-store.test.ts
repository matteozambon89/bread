import { describe, expect, test } from 'bun:test'
import { APICallError, type EmbeddingModel } from 'ai'
import {
  defineConfig,
  embedStoreText,
  type BreadStore,
  type EmbeddingRegistry,
} from '@breadai/core'

function model(doEmbed: EmbeddingModel['doEmbed']): EmbeddingModel {
  return {
    modelId: 'text-embedding-3-small',
    provider: 'test.embedding',
    specificationVersion: 'v4',
    doEmbed,
  }
}

describe('embedStoreText', () => {
  test('does not call a factory or ai.embed while the config is defined', async () => {
    let factoryCalls = 0
    let embedCalls = 0
    const embeddings: EmbeddingRegistry = {
      openai: () => {
        factoryCalls += 1
        return model(async () => {
          embedCalls += 1
          return { embeddings: [[1]] }
        })
      },
    }
    const store = {} as BreadStore
    defineConfig({ entrypoints: ['writer'], store, embeddings })
    expect(factoryCalls).toBe(0)
    expect(embedCalls).toBe(0)
  })

  test('calls a function as-is and does not read config.embeddings', async () => {
    let factoryCalls = 0
    let functionCalls = 0
    const store = {} as BreadStore
    const config = defineConfig({
      entrypoints: ['writer'],
      store,
      embeddings: {
        openai: () => {
          factoryCalls += 1
          throw new Error('registry should not run')
        },
      },
    })
    const spec = async (text: string) => {
      functionCalls += 1
      return [text.length]
    }
    expect(await embedStoreText(store, spec, 'abcd')).toEqual([4])
    config.embeddings = {
      openai: () => {
        factoryCalls += 1
        throw new Error('replacement should not run')
      },
    }
    expect(await embedStoreText(store, spec, 'ab')).toEqual([2])
    expect(functionCalls).toBe(2)
    expect(factoryCalls).toBe(0)
  })

  test('a function works when the store was never bound', async () => {
    const spec = async () => [7]
    expect(await embedStoreText({}, spec, 'x')).toEqual([7])
  })

  test('a ref without a binding throws EMBEDDINGS_NOT_BOUND', async () => {
    await expect(
      embedStoreText({}, { provider: 'openai', model: 'text-embedding-3-small' }, 'x'),
    ).rejects.toMatchObject({ code: 'EMBEDDINGS_NOT_BOUND' })
  })

  test('a ref reads the live registry on the bound config object', async () => {
    let firstCalls = 0
    const store = {} as BreadStore
    const config = defineConfig({
      entrypoints: ['writer'],
      store,
      embeddings: {
        openai: () => {
          firstCalls += 1
          return model(async () => ({ embeddings: [[1]] }))
        },
      },
    })
    expect(firstCalls).toBe(0)
    config.embeddings = {}
    await expect(
      embedStoreText(store, { provider: 'openai', model: 'text-embedding-3-small' }, 'hi'),
    ).rejects.toMatchObject({ code: 'UNKNOWN_EMBEDDING_PROVIDER' })
    expect(firstCalls).toBe(0)

    let secondCalls = 0
    config.embeddings = {
      openai: (modelId) => {
        secondCalls += 1
        expect(modelId).toBe('text-embedding-3-small')
        return model(async ({ values }) => {
          expect(values).toEqual(['hi'])
          return { embeddings: [[0.25, 0.5]] }
        })
      },
    }
    expect(
      await embedStoreText(store, { provider: 'openai', model: 'text-embedding-3-small' }, 'hi'),
    ).toEqual([0.25, 0.5])
    expect(secondCalls).toBe(1)
  })

  test('keeps each store bound to its own config', async () => {
    const storeA = {} as BreadStore
    const storeB = {} as BreadStore
    let callsA = 0
    let callsB = 0
    const configA = defineConfig({
      entrypoints: ['a'],
      store: storeA,
      embeddings: {
        openai: () => {
          callsA += 1
          return model(async () => ({ embeddings: [[1]] }))
        },
      },
    })
    defineConfig({
      entrypoints: ['b'],
      store: storeB,
      embeddings: {
        openai: () => {
          callsB += 1
          return model(async () => ({ embeddings: [[2, 3]] }))
        },
      },
    })
    configA.embeddings = {}
    await expect(
      embedStoreText(storeA, { provider: 'openai', model: 'm' }, 'x'),
    ).rejects.toMatchObject({ code: 'UNKNOWN_EMBEDDING_PROVIDER' })
    expect(await embedStoreText(storeB, { provider: 'openai', model: 'm' }, 'x')).toEqual([2, 3])
    expect(callsA).toBe(0)
    expect(callsB).toBe(1)
  })

  test('calls ai.embed with maxRetries 0', async () => {
    let tries = 0
    const store = {} as BreadStore
    defineConfig({
      entrypoints: ['writer'],
      store,
      embeddings: {
        openai: () =>
          model(async () => {
            tries += 1
            throw new APICallError({
              message: 'rate limit',
              url: 'https://example.test/embed',
              requestBodyValues: {},
              statusCode: 429,
              isRetryable: true,
            })
          }),
      },
    })
    await expect(
      embedStoreText(store, { provider: 'openai', model: 'text-embedding-3-small' }, 'hi'),
    ).rejects.toThrow('rate limit')
    expect(tries).toBe(1)
  })
})
