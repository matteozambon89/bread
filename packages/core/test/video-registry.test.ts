import { describe, expect, test } from 'bun:test'
import { resolveVideoModel, type VideoModel, type VideoRegistry } from '@breadai/core'

function videoModel(provider: string, modelId: string): VideoModel {
  return { specificationVersion: 'v4', provider, modelId } as VideoModel
}

describe('resolveVideoModel', () => {
  test('returns the model from the matching factory and passes the model id', async () => {
    let seen = ''
    const registry: VideoRegistry = {
      fal: (modelId) => {
        seen = modelId
        return videoModel('fal', modelId)
      },
    }
    const resolved = await resolveVideoModel(registry, 'fal', 'ray-2')
    expect(seen).toBe('ray-2')
    expect(resolved).toMatchObject({ specificationVersion: 'v4', provider: 'fal', modelId: 'ray-2' })
  })

  test('supports an async factory', async () => {
    const expected = videoModel('google', 'veo-3')
    const registry: VideoRegistry = { google: async () => expected }
    expect(await resolveVideoModel(registry, 'google', 'veo-3')).toBe(expected)
  })

  test('throws VIDEO_NOT_CONFIGURED when the registry is unset', async () => {
    await expect(resolveVideoModel(undefined, 'fal', 'ray-2')).rejects.toMatchObject({
      code: 'VIDEO_NOT_CONFIGURED',
    })
  })

  test('throws UNKNOWN_VIDEO_PROVIDER naming the registered providers', async () => {
    const err = await resolveVideoModel({ fal: () => videoModel('fal', 'x') }, 'google', 'veo').catch(
      (error) => error,
    )
    expect(err.code).toBe('UNKNOWN_VIDEO_PROVIDER')
    expect(err.message).toContain('google')
    expect(err.message).toContain('fal')
  })

  test('throws UNKNOWN_VIDEO_PROVIDER when the registry is empty', async () => {
    const err = await resolveVideoModel({}, 'fal', 'ray-2').catch((error) => error)
    expect(err.code).toBe('UNKNOWN_VIDEO_PROVIDER')
    expect(err.message).toContain('No video providers are registered')
  })
})
