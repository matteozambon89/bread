import { describe, expect, test } from 'bun:test'
import { defineConfig } from '@breadai/core'
import type { BreadConfig } from '@breadai/core'

describe('defineConfig', () => {
  test('returns the same config object, unmodified (identity passthrough)', () => {
    const config: BreadConfig = { entrypoints: ['a'] }
    expect(defineConfig(config)).toBe(config)
  })
})
