import { describe, expect, test } from 'bun:test'
import { defineConfig } from '@bread/core'
import type { BreadConfig } from '@bread/core'

describe('defineConfig', () => {
  test('returns the same config object, unmodified (identity passthrough)', () => {
    const config: BreadConfig = { entrypoints: ['a'] }
    expect(defineConfig(config)).toBe(config)
  })
})
