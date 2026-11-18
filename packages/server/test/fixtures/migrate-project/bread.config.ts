import { defineConfig } from '@breadai/core'

const store = (globalThis as Record<string, unknown>)['__breadMigrateTestStore']
if (!store) throw new Error('migrate-project fixture requires globalThis.__breadMigrateTestStore')

export default defineConfig({
  entrypoints: [],
  providers: {},
  server: { migrate: false },
  store: store as never,
})
