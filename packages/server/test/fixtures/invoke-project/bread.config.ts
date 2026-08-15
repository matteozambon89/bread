import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-sse'
import { mockProvider } from '@breadai/test-utils'

// The test sets `globalThis.__breadInvokeTestModel` to a mock LanguageModel
// before each `runInvoke` call — loadConfig re-imports this module fresh
// every call (see loader.ts's cache-busting), so each test drives a different
// scripted response through the same fixture agent.
const model = (globalThis as Record<string, unknown>)['__breadInvokeTestModel']
if (!model) {
  throw new Error('invoke-project fixture requires globalThis.__breadInvokeTestModel to be set first')
}

export default defineConfig({
  entrypoints: ['agent'],
  store: store(),
  transport: transport(),
  providers: mockProvider({ default: model as never }),
})
