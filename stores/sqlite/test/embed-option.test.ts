import { expect, test } from 'bun:test'
import { type SqliteStoreOptions } from '@breadai/store-sqlite'

test('sqlite options have no embed field', () => {
  const marker: 'embed' extends keyof SqliteStoreOptions ? 'yes' : 'no' = 'no'
  expect(marker).toBe('no')
})
