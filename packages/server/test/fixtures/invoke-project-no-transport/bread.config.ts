import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { mockProvider } from '@breadai/test-utils'

// A store but no transport — exercises runInvoke's own TRANSPORT_NOT_CONFIGURED
// guard (distinct from createServer's).
const model = (globalThis as Record<string, unknown>)['__breadInvokeTestModel']
if (!model) {
  throw new Error('fixture requires globalThis.__breadInvokeTestModel to be set first')
}

export default defineConfig({
  entrypoints: ['agent'],
  store: store(),
  providers: mockProvider({ default: model as never }),
})
