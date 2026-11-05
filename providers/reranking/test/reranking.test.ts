import { describe, expect, mock, test } from 'bun:test'
import { resolveReranking } from '@breadai/core'
import { providerReranking } from '@breadai/provider-reranking'
import { rerankingModelFrom } from '../src/load.ts'

const CATALOG = ['amazon-bedrock', 'cohere', 'togetherai', 'voyage'] as const

const PACKAGES: Record<(typeof CATALOG)[number], string> = {
  cohere: '@ai-sdk/cohere',
  'amazon-bedrock': '@ai-sdk/amazon-bedrock',
  togetherai: '@ai-sdk/togetherai',
  voyage: '@ai-sdk/voyage',
}

describe('providerReranking', () => {
  test('registers only cohere, amazon-bedrock, togetherai, and voyage', () => {
    expect(Object.keys(providerReranking).sort()).toEqual([...CATALOG].sort())
    expect(providerReranking['openai-compatible']).toBeUndefined()
  })

  test('spreading providerReranking does not throw', () => {
    expect(() => ({ ...providerReranking })).not.toThrow()
  })

  test.serial('throws MISSING_PROVIDER naming the package to install', async () => {
    for (const provider of CATALOG) {
      const err = await resolveReranking(
        { provider, model: 'x' },
        providerReranking,
      ).catch((error) => error)
      expect(err.code).toBe('MISSING_PROVIDER')
      expect(err.message).toContain(PACKAGES[provider])
      expect(err.message).toContain(`bun add ${PACKAGES[provider]}`)
    }
  })

  test.serial('an installed peer that fails to evaluate is not reported as missing', async () => {
    mock.module('@ai-sdk/cohere', () => {
      throw new Error('transitive module failed to evaluate')
    })
    const broken = await resolveReranking(
      { provider: 'cohere', model: 'x' },
      providerReranking,
    ).catch((error) => error)
    expect((broken as { code?: string }).code).not.toBe('MISSING_PROVIDER')
    expect((broken as Error).message).toContain('transitive module failed to evaluate')

    const transitive = new Error(
      "Cannot find package 'some-transitive' imported from '/node_modules/@ai-sdk/voyage/dist/index.js'",
    )
    Object.assign(transitive, { code: 'ERR_MODULE_NOT_FOUND' })
    mock.module('@ai-sdk/voyage', () => {
      throw transitive
    })
    const missingDep = await resolveReranking(
      { provider: 'voyage', model: 'x' },
      providerReranking,
    ).catch((error) => error)
    expect((missingDep as { code?: string }).code).not.toBe('MISSING_PROVIDER')
    expect((missingDep as Error).message).toContain('some-transitive')
  })

  test('an unknown name still throws UNKNOWN_RERANKING_PROVIDER', async () => {
    const err = await resolveReranking(
      { provider: 'openai-compatible', model: 'x' },
      providerReranking,
    ).catch((error) => error)
    expect(err.code).toBe('UNKNOWN_RERANKING_PROVIDER')
  })
})

describe('rerankingModelFrom', () => {
  test('reads .reranking on a plain object and does not call languageModel', () => {
    const voyage = {
      languageModel() {
        throw new Error('languageModel should not be called')
      },
      reranking(modelId: string) {
        return { kind: 'reranking', modelId }
      },
    }
    const model = rerankingModelFrom({ voyage }, 'voyage', 'voyage', '@ai-sdk/voyage', 'rerank-2.5')
    expect(model).toEqual({ kind: 'reranking', modelId: 'rerank-2.5' })
  })

  test('calls .reranking(modelId) and not the language-model factory', () => {
    let languageCalls = 0
    const cohere = Object.assign(
      () => {
        languageCalls += 1
        return { kind: 'language' }
      },
      {
        reranking(modelId: string) {
          return { kind: 'reranking', modelId }
        },
      },
    )
    const model = rerankingModelFrom({ cohere }, 'cohere', 'cohere', '@ai-sdk/cohere', 'rerank-v3.5')
    expect(languageCalls).toBe(0)
    expect(model).toEqual({ kind: 'reranking', modelId: 'rerank-v3.5' })
  })

  test('throws PROVIDER_EXPORT_MISSING when the export has no reranking method', () => {
    let err: unknown
    try {
      rerankingModelFrom({ cohere: () => ({}) }, 'cohere', 'cohere', '@ai-sdk/cohere', 'x')
    } catch (error) {
      err = error
    }
    expect(err).toMatchObject({ code: 'PROVIDER_EXPORT_MISSING' })
    expect((err as Error).message).toContain('@ai-sdk/cohere')
    expect((err as Error).message).toContain('reranking')
  })

  test('throws PROVIDER_EXPORT_MISSING when the named export is missing', () => {
    expect(() =>
      rerankingModelFrom({}, 'cohere', 'cohere', '@ai-sdk/cohere', 'x'),
    ).toThrow(/no "reranking" method/)
  })
})
