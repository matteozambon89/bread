import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { EmbeddingModel } from 'ai'
import type { EmbeddingRegistry } from '@breadai/core'

describe('knowledge-graph embeddings', () => {
  test('document writes use the live embeddings registry and fail when the key is missing', async () => {
    const prevUrl = process.env.DATABASE_URL
    const prevCwd = process.cwd()
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/bread'
    process.chdir(mkdtempSync(join(tmpdir(), 'kg-embed-')))
    try {
      const { default: config } = await import('./bread.config.ts')
      expect(config.store).toBeDefined()
      config.embeddings = {}
      await expect(
        config.store!.ingestDocument({ agentId: 'memory', title: 'note', content: 'hello' }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_EMBEDDING_PROVIDER' })

      let calls = 0
      const embeddings: EmbeddingRegistry = {
        ollama: () => {
          calls += 1
          return {
            modelId: 'nomic-embed-text',
            provider: 'test.embedding',
            specificationVersion: 'v4',
            async doEmbed() {
              throw new Error('stop before sql')
            },
          } as EmbeddingModel
        },
      }
      config.embeddings = embeddings
      await expect(
        config.store!.ingestDocument({ agentId: 'memory', title: 'note', content: 'hello' }),
      ).rejects.toThrow('stop before sql')
      expect(calls).toBe(1)
    } finally {
      process.chdir(prevCwd)
      if (prevUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevUrl
    }
  })
})
