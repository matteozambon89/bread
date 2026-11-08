import { describe, expect, test } from 'bun:test'

describe('custom embed', () => {
  test('does not run at import, then ingest runs it once and fails before sql', async () => {
    const prevUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/bread'
    try {
      const { default: config, customEmbedCalls } = await import('./bread.config.ts')
      expect(customEmbedCalls()).toBe(0)
      expect(config.store).toBeDefined()
      await expect(
        config.store!.ingestDocument({ agentId: 'echo', title: 'note', content: 'hello' }),
      ).rejects.toThrow('stop before sql')
      expect(customEmbedCalls()).toBe(1)
    } finally {
      if (prevUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevUrl
    }
  })
})
