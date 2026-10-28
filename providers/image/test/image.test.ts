import { describe, expect, test } from 'bun:test'
import { BreadError, resolveImageModel } from '@breadai/core'
import { imageEntries, importFailure, providerImage, providerInstance } from '@breadai/provider-image'

const NAMES = [
  'amazon-bedrock',
  'azure',
  'black-forest-labs',
  'bytedance',
  'deepinfra',
  'fal',
  'fireworks',
  'google',
  'google-vertex',
  'luma',
  'openai',
  'openai-compatible',
  'prodia',
  'quiverai',
  'replicate',
  'togetherai',
  'topaz',
  'xai',
]

describe('providerImage', () => {
  test('exposes all 18 image provider names', () => {
    expect(Object.keys(providerImage).sort()).toEqual([...NAMES].sort())
  })

  test('spreading providerImage does not throw', () => {
    expect(() => ({ ...providerImage })).not.toThrow()
  })

  test('throws MISSING_PROVIDER when the @ai-sdk package is not installed', async () => {
    await expect(resolveImageModel(providerImage, 'fal', 'flux')).rejects.toMatchObject({
      code: 'MISSING_PROVIDER',
    })
  })

  test('the missing-provider error names the provider and the package to install', async () => {
    const err = await resolveImageModel(providerImage, 'luma', 'photon-1').catch((e) => e)
    expect(err.code).toBe('MISSING_PROVIDER')
    expect(err.message).toContain('@ai-sdk/luma')
    expect(err.message).toContain('bun add @ai-sdk/luma')
  })

  test('uninstalled openai-compatible still throws MISSING_PROVIDER', async () => {
    await expect(
      resolveImageModel(providerImage, 'openai-compatible', 'image'),
    ).rejects.toMatchObject({ code: 'MISSING_PROVIDER' })
  })

  test('openai-compatible fromEnv throws PROVIDER_NOT_CONFIGURED when OPENAI_COMPATIBLE_BASE_URL is unset', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    delete process.env.OPENAI_COMPATIBLE_BASE_URL
    try {
      let err: unknown
      try {
        imageEntries['openai-compatible']?.create?.fromEnv()
      } catch (e) {
        err = e
      }
      expect(err).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' })
      expect((err as Error).message).toContain('openai-compatible')
      expect((err as Error).message).toContain('OPENAI_COMPATIBLE_BASE_URL')
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevUrl
    }
  })

  test('openai-compatible fromEnv returns name+baseURL without apiKey when only the base URL is set', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const prevKey = process.env.OPENAI_COMPATIBLE_API_KEY
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1'
    delete process.env.OPENAI_COMPATIBLE_API_KEY
    try {
      expect(imageEntries['openai-compatible']?.create?.fromEnv()).toEqual({
        name: 'openai-compatible',
        baseURL: 'http://localhost:11434/v1',
      })
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevUrl
      if (prevKey === undefined) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = prevKey
    }
  })

  test('openai-compatible fromEnv forwards apiKey when OPENAI_COMPATIBLE_API_KEY is set', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const prevKey = process.env.OPENAI_COMPATIBLE_API_KEY
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test'
    try {
      expect(imageEntries['openai-compatible']?.create?.fromEnv()).toEqual({
        name: 'openai-compatible',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'sk-test',
      })
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevUrl
      if (prevKey === undefined) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = prevKey
    }
  })

  test('a function export is the provider instance', () => {
    function openai(modelId: string) {
      return modelId
    }
    expect(providerInstance('openai', imageEntries.openai!, openai)).toBe(openai)
  })

  test('a plain object export with image() is the provider instance', () => {
    const fal = { image: (modelId: string) => modelId }
    const entry = imageEntries.fal!
    expect(providerInstance('fal', entry, fal)).toBe(fal)
    const image = (fal as { image: (id: string) => string }).image
    expect(image.call(fal, 'flux')).toBe('flux')
  })

  test('a string or undefined export is PROVIDER_EXPORT_MISSING', () => {
    const entry = imageEntries.fal!
    for (const exported of ['fal', undefined]) {
      let err: unknown
      try {
        providerInstance('fal', entry, exported)
      } catch (e) {
        err = e
      }
      expect(err).toMatchObject({ code: 'PROVIDER_EXPORT_MISSING' })
      expect((err as Error).message).toContain(entry.export)
    }
  })

  test('importFailure maps a missing module to MISSING_PROVIDER', () => {
    const byCode = importFailure(
      Object.assign(new Error('loader failed'), { code: 'ERR_MODULE_NOT_FOUND' }),
      'fal',
      '@ai-sdk/fal',
    )
    expect(byCode).toMatchObject({ code: 'MISSING_PROVIDER' })
    expect(byCode.message).toContain('bun add @ai-sdk/fal')

    const byMessage = importFailure(
      new Error("Cannot find package '@ai-sdk/luma' imported from /app/index.ts"),
      'luma',
      '@ai-sdk/luma',
    )
    expect(byMessage.code).toBe('MISSING_PROVIDER')
    expect(byMessage.message).toContain('bun add @ai-sdk/luma')
  })

  test('importFailure keeps any other import error message and cause', () => {
    const cause = new Error('Unexpected token in @ai-sdk/fal')
    const err = importFailure(cause, 'fal', '@ai-sdk/fal')
    expect(err).toBeInstanceOf(BreadError)
    expect(err.code).not.toBe('MISSING_PROVIDER')
    expect(err.message).toContain(cause.message)
    expect(err.cause).toBe(cause)
  })

  test('shared vendors keep the provider-llm export name', () => {
    expect(imageEntries.openai?.export).toBe('openai')
    expect(imageEntries['google-vertex']?.export).toBe('vertex')
    expect(imageEntries['amazon-bedrock']?.export).toBe('bedrock')
    expect(imageEntries.deepinfra?.export).toBe('deepinfra')
    expect(imageEntries['openai-compatible']?.method).toBe('imageModel')
    expect(imageEntries.fal?.method).toBeUndefined()
  })
})
