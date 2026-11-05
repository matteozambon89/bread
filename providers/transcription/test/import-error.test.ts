import { describe, expect, mock, test } from 'bun:test'

mock.module('@ai-sdk/revai', () => {
  throw Object.assign(new Error('revai peer failed to evaluate'), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
})

mock.module('@ai-sdk/assemblyai', () => {
  throw Object.assign(new Error("Cannot find package 'missing-transitive'"), {
    code: 'ERR_MODULE_NOT_FOUND',
    specifier: 'missing-transitive',
  })
})

const { providerTranscription } = await import('@breadai/provider-transcription')

describe('provider import errors', () => {
  test('does not report an installed peer that fails to evaluate as MISSING_PROVIDER', async () => {
    const err = await providerTranscription.revai!('model').catch((error: unknown) => error)
    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).not.toBe('MISSING_PROVIDER')
    expect((err as Error).message).toContain('revai peer failed to evaluate')
  })

  test('does not report a missing transitive import as the peer being absent', async () => {
    const err = await providerTranscription.assemblyai!('model').catch((error: unknown) => error)
    expect((err as { code?: string }).code).not.toBe('MISSING_PROVIDER')
    expect((err as Error).message).toContain('missing-transitive')
  })
})
