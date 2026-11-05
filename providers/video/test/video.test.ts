import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVideoModel, type VideoModel } from '@breadai/core'
import { providerVideo, videoEntries } from '@breadai/provider-video'

const nodeModules = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules')

function peerDir(pkg: string): string {
  return join(nodeModules, ...pkg.split('/'))
}

// existsSync, not require.resolve: a failed resolve is cached for the process,
// so a fixture written after that probe stays invisible to import().
function packageInstalled(pkg: string): boolean {
  return existsSync(join(peerDir(pkg), 'package.json'))
}

// Recorded before any fixture is written. A planted package.json must not look
// like a peer the user installed.
const realInstalled = new Set(
  Object.entries(videoEntries)
    .filter(([, entry]) => packageInstalled(entry.pkg))
    .map(([name]) => name),
)

// Broken installs, created only when the real peer is absent. An import failure
// here must not be rewritten into "run bun add".
const brokenPeers: Array<{ provider: string; pkg: string; files: Record<string, string> }> = []
if (!realInstalled.has('topaz')) {
  brokenPeers.push({
    provider: 'topaz',
    pkg: '@ai-sdk/topaz',
    files: {
      'package.json': '{"name":"@ai-sdk/topaz","type":"module","exports":{".":"./index.js"}}',
      'index.js': 'import "topaz-missing-dep"; export const topaz = { video() { return {} } }\n',
    },
  })
}
if (!realInstalled.has('alibaba')) {
  brokenPeers.push({
    provider: 'alibaba',
    pkg: '@ai-sdk/alibaba',
    files: {
      'package.json': '{"name":"@ai-sdk/alibaba","type":"module","exports":{".":"./missing.js"}}',
    },
  })
}
if (!realInstalled.has('heygen')) {
  brokenPeers.push({
    provider: 'heygen',
    pkg: '@ai-sdk/heygen',
    files: {
      'package.json': '{"name":"@ai-sdk/heygen","type":"module","exports":{".":"./index.js"}}',
      'index.js': 'throw new Error("top-level boom")\n',
    },
  })
}
for (const peer of brokenPeers) {
  const dir = peerDir(peer.pkg)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(peer.files)) writeFileSync(join(dir, name), body)
}
afterAll(() => {
  for (const peer of brokenPeers) rmSync(peerDir(peer.pkg), { recursive: true, force: true })
})

function videoModel(provider: string, modelId: string): VideoModel {
  return { specificationVersion: 'v3', provider, modelId } as VideoModel
}

// Stub export shapes only when the real peer is absent. An installed package
// has to be the one `instance.video(modelId)` calls.
if (!realInstalled.has('fal')) {
  mock.module('@ai-sdk/fal', () => ({
    fal: {
      video(modelId: string) {
        return videoModel('fal', modelId)
      },
    },
  }))
}

if (!realInstalled.has('klingai')) {
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
}

if (!realInstalled.has('replicate')) {
  mock.module('@ai-sdk/replicate', () => ({
    replicate: {},
  }))
}

if (!realInstalled.has('prodia')) {
  mock.module('@ai-sdk/prodia', () => ({
    prodia: {
      marker: 'prodia',
      video(modelId: string) {
        if ((this as { marker?: string } | undefined)?.marker !== 'prodia') {
          throw new Error('video lost its receiver')
        }
        return videoModel('prodia', modelId)
      },
    },
  }))
}

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
    if (realInstalled.has('fal')) {
      expectVideo(resolved, 'luma-dream-machine/ray-2')
      return
    }
    expect(resolved).toEqual(videoModel('fal', 'luma-dream-machine/ray-2'))
  })

  test('returns a video model from a callable provider export', async () => {
    const resolved = await resolveVideoModel(providerVideo, 'klingai', 'kling-v1')
    if (realInstalled.has('klingai')) {
      expectVideo(resolved, 'kling-v1')
      return
    }
    expect(resolved).toEqual(videoModel('klingai', 'kling-v1'))
  })

  test('throws PROVIDER_EXPORT_MISSING when the instance has no video', async () => {
    if (realInstalled.has('replicate')) {
      expectVideo(await resolveVideoModel(providerVideo, 'replicate', 'model'), 'model')
      return
    }
    const err = await resolveVideoModel(providerVideo, 'replicate', 'model').catch((error) => error)
    expect(err.code).toBe('PROVIDER_EXPORT_MISSING')
    expect(err.message).toContain('replicate.video')
  })

  test('calls video with the provider instance as this', async () => {
    const resolved = await resolveVideoModel(providerVideo, 'prodia', 'model')
    if (realInstalled.has('prodia')) {
      expectVideo(resolved, 'model')
      return
    }
    expect(resolved).toEqual(videoModel('prodia', 'model'))
  })

  test('a failed provider import keeps the original error unless the package is absent', async () => {
    if (brokenPeers.some((peer) => peer.provider === 'heygen')) {
      const heygen = await resolveVideoModel(providerVideo, 'heygen', 'avatar').catch((error) => error)
      expect(heygen.code).not.toBe('MISSING_PROVIDER')
      expect(heygen.message).toContain('top-level boom')
    }
    if (brokenPeers.some((peer) => peer.provider === 'topaz')) {
      const topaz = await resolveVideoModel(providerVideo, 'topaz', 'model').catch((error) => error)
      expect(topaz.code).not.toBe('MISSING_PROVIDER')
      expect(topaz.message).toContain('topaz-missing-dep')
    }
    if (brokenPeers.some((peer) => peer.provider === 'alibaba')) {
      const alibaba = await resolveVideoModel(providerVideo, 'alibaba', 'model').catch((error) => error)
      expect(alibaba.code).not.toBe('MISSING_PROVIDER')
      expect(alibaba.message).not.toContain('bun add @ai-sdk/alibaba')
    }
  })

  test('throws MISSING_PROVIDER when the @ai-sdk package is not installed', async () => {
    if (realInstalled.has('bytedance')) return
    await expect(resolveVideoModel(providerVideo, 'bytedance', 'seedance')).rejects.toMatchObject({
      code: 'MISSING_PROVIDER',
    })
  })

  test('the missing-provider error names the package to install', async () => {
    if (realInstalled.has('google-vertex')) return
    const err = await resolveVideoModel(providerVideo, 'google-vertex', 'veo-3').catch((error) => error)
    expect(err.code).toBe('MISSING_PROVIDER')
    expect(err.message).toContain('@ai-sdk/google-vertex')
    expect(err.message).toContain('bun add @ai-sdk/google-vertex')
  })

  test('an installed catalog peer is resolved and a missing one names the package', async () => {
    const planted = new Set(brokenPeers.map((peer) => peer.provider))
    for (const name of NAMES) {
      if (planted.has(name)) continue
      const pkg = videoEntries[name]!.pkg
      if (!realInstalled.has(name)) {
        // Shape stubs stand in for an absent package. They are not a missing install.
        if (STUBBED.has(name) || name === 'prodia') continue
        const err = await resolveVideoModel(providerVideo, name, 'model').catch((error) => error)
        expect(err.code).toBe('MISSING_PROVIDER')
        expect(err.message).toContain(pkg)
        continue
      }
      const resolved = await resolveVideoModel(providerVideo, name, 'model').catch((error) => error)
      if (resolved instanceof Error) {
        expect(resolved).not.toMatchObject({ code: 'MISSING_PROVIDER' })
        expect(resolved).not.toMatchObject({ code: 'PROVIDER_EXPORT_MISSING' })
        continue
      }
      expectVideo(resolved, 'model')
    }
  })
})

function expectVideo(resolved: VideoModel, modelId: string) {
  expect(resolved.specificationVersion === 'v3' || resolved.specificationVersion === 'v4').toBe(true)
  expect(resolved.modelId).toBe(modelId)
  const methods = resolved as { doGenerate?: unknown; doStart?: unknown }
  expect(typeof methods.doGenerate === 'function' || typeof methods.doStart === 'function').toBe(true)
}
