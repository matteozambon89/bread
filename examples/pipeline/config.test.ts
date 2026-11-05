import { expect, test } from 'bun:test'
import config from './bread.config.ts'

test('article does not share a throwing blob store', () => {
  expect(config.blobStore).toBeUndefined()
})
