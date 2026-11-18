import { expect, test } from 'bun:test'
import { store } from '@breadai/store-memory'

test('memory migrate and the read-only check are an empty journal', async () => {
  const backend = store()
  expect(await backend.migrations?.()).toEqual({ pending: [] })
  expect(await backend.migrate?.()).toEqual({ applied: [], skipped: [] })
})
