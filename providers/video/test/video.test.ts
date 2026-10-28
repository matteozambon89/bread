import { describe, expect, mock, test } from 'bun:test'
import { resolveVideoModel, type VideoModel } from '@breadai/core'
import { providerVideo, videoEntries } from '@breadai/provider-video'

function videoModel(provider: string, modelId: string): VideoModel {
  return { specificationVersion: 'v3', provider, modelId } as VideoModel
}

// Installed peers are not in this workspace. Stub the two export shapes the
// catalog has to call, plus an object that has no `.video`.
mock.module('@ai-sdk/fal', () => ({
  fal: {
    video(modelId: string) {
      return videoModel('fal', modelId)
    },
  },
}))

mock.module('@ai-sdk/klingai', () => ({
  klingai: Object.assign(
    (modelId: string) => videoModel('klingai-language', modelId),
    {
      video(modelId: string) {
        return videoModel('klingai', modelId)
      },
    },
  ),
}))

mock.module('@ai-sdk/replicate', () => ({
  replicate: {},
}))

const STUBBED = new Set(['fal', 'klingai', 'replicate'])

const NAMES = [
  'alibaba',
  'black-forest-labs',
  'bytedance',
  'fal',
  'google',
  'google-vertex',
  'heygen',
  'klingai',
  'minimax',
  'prodia',
  'replicate',
  'topaz',
  'xai',
]

describe('providerVideo', () => {
  test('exposes exactly the 13 video providers', () => {
    expect(Object.keys(providerVideo).sort()).toEqual([...NAMES].sort())
    expect(providerVideo['openai-compatible']).toBeUndefined()
  })

  test('reuses the provider-llm key and the AI SDK instance export', () => {
    expect(videoEntries.google).toEqual({ pkg: '@ai-sdk/google', export: 'google' })
    expect(videoEntries['google-vertex']).toEqual({ pkg: '@ai-sdk/google-vertex', export: 'vertex' })
    expect(videoEntries.xai).toEqual({ pkg: '@ai-sdk/xai', export: 'xai' })
    expect(videoEntries['black-forest-labs']).toEqual({
      pkg: '@ai-sdk/black-forest-labs',
      export: 'blackForestLabs',
    })
    expect(videoEntries.bytedance).toEqual({ pkg: '@ai-sdk/bytedance', export: 'byteDance' })
    expect(videoEntries.klingai).toEqual({ pkg: '@ai-sdk/klingai', export: 'klingai' })
  })

  test('spreading providerVideo does not throw', () => {
    expect(() => ({ ...providerVideo })).not.toThrow()
  })

  test('returns a video model from an object-shaped provider export', async () => {
    const resolved = await resolveVideoModel(providerVideo, 'fal', 'luma-dream-machine/ray-2')
    expect(resolved).toEqual(videoModel('fal', 'luma-dream-machine/ray-2'))
  })

  test('returns a video model from a callable provider export', async () => {
    const resolved = await resolveVideoModel(providerVideo, 'klingai', 'kling-v1')
    expect(resolved).toEqual(videoModel('klingai', 'kling-v1'))
  })

  test('throws PROVIDER_EXPORT_MISSING when the instance has no video', async () => {
    const err = await resolveVideoModel(providerVideo, 'replicate', 'model').catch((error) => error)
    expect(err.code).toBe('PROVIDER_EXPORT_MISSING')
    expect(err.message).toContain('replicate.video')
  })

  test('throws MISSING_PROVIDER when the @ai-sdk package is not installed', async () => {
    await expect(resolveVideoModel(providerVideo, 'bytedance', 'seedance')).rejects.toMatchObject({
      code: 'MISSING_PROVIDER',
    })
  })

  test('the missing-provider error names the package to install', async () => {
    const err = await resolveVideoModel(providerVideo, 'google-vertex', 'veo-3').catch((error) => error)
    expect(err.code).toBe('MISSING_PROVIDER')
    expect(err.message).toContain('@ai-sdk/google-vertex')
    expect(err.message).toContain('bun add @ai-sdk/google-vertex')
  })

  test('every catalog peer without a stub is reported missing until installed', async () => {
    for (const name of NAMES) {
      if (STUBBED.has(name)) continue
      const err = await resolveVideoModel(providerVideo, name, 'model').catch((error) => error)
      expect(err.code).toBe('MISSING_PROVIDER')
      expect(err.message).toContain(videoEntries[name]!.pkg)
    }
  })
})
