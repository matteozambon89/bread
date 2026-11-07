import { expect, test } from 'bun:test'
import { store } from '@breadai/store-memory'

test('memory store takes no options', () => {
  const marker: Parameters<typeof store> extends [] ? 'none' : 'options' = 'none'
  expect(marker).toBe('none')
  expect(store()).toBeDefined()
})
