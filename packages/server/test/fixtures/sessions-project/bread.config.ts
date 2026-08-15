import { defineConfig } from '@bread/core'

// The test sets `globalThis.__breadSessionsTestStore` to a shared
// `@bread/store-memory` instance before each command call, so it can seed and
// stub the same store the command ends up talking to (loadConfig re-imports
// this module fresh every call — see loader.ts's cache-busting).
export default defineConfig({
  entrypoints: [],
  providers: {},
  store: (globalThis as Record<string, unknown>)['__breadSessionsTestStore'] as never,
})
