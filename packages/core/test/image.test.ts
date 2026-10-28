import { describe, expect, test } from 'bun:test'
import { BreadError, resolveImageModel } from '@breadai/core'
import type { ImageModel } from 'ai'

const model = { specificationVersion: 'v4' } as ImageModel

describe('resolveImageModel', () => {
  test('throws IMAGE_NOT_CONFIGURED when no registry is set', async () => {
    await expect(resolveImageModel(undefined, 'openai', 'gpt-image-1')).rejects.toMatchObject({
      code: 'IMAGE_NOT_CONFIGURED',
    })
  })

  test('throws UNKNOWN_IMAGE_PROVIDER and names the registered keys', async () => {
    const err = await resolveImageModel({ openai: () => model }, 'fal', 'flux').catch((e) => e)
    expect(err).toBeInstanceOf(BreadError)
    expect(err.code).toBe('UNKNOWN_IMAGE_PROVIDER')
    expect(err.message).toContain('fal')
    expect(err.message).toContain('openai')
  })

  test('throws UNKNOWN_IMAGE_PROVIDER when the registry is empty', async () => {
    const err = await resolveImageModel({}, 'openai', 'gpt-image-1').catch((e) => e)
    expect(err).toBeInstanceOf(BreadError)
    expect(err.code).toBe('UNKNOWN_IMAGE_PROVIDER')
    expect(err.message).toContain('No image providers are registered')
  })

  test('passes the model id to the factory and returns its ImageModel', async () => {
    let seen = ''
    const resolved = await resolveImageModel(
      {
        openai: (modelId) => {
          seen = modelId
          return model
        },
      },
      'openai',
      'gpt-image-1',
    )
    expect(seen).toBe('gpt-image-1')
    expect(resolved).toBe(model)
  })

  test('awaits an async factory', async () => {
    const resolved = await resolveImageModel({ openai: async () => model }, 'openai', 'gpt-image-1')
    expect(resolved).toBe(model)
  })
})
