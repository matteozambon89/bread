import { defineConfig } from '@bread/core'
import { store } from '@bread/store-memory'
import { mockProvider } from '@bread/test-utils'

// The test sets `globalThis.__breadEvalTestModel` to a mock LanguageModel
// before each `runEvalCommand` call — loadConfig re-imports this module fresh
// every call (see loader.ts's cache-busting).
const model = (globalThis as Record<string, unknown>)['__breadEvalTestModel']
if (!model) {
  throw new Error('eval-project fixture requires globalThis.__breadEvalTestModel to be set first')
}

export default defineConfig({
  entrypoints: ['agent'],
  store: store(),
  providers: mockProvider({ default: model as never }),
})
