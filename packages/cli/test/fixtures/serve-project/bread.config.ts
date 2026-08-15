import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-chunked'
import { mockProvider, mockTextModel } from '@breadai/test-utils'

// Fixture for packages/cli/test/serve.test.ts — a mount-capable transport
// (required by `bread start`/`bread dev`), with config.server.port set so
// tests can prove an explicit --port flag actually overrides it.
export default defineConfig({
  entrypoints: ['echo'],
  store: store(),
  transport: transport(),
  providers: mockProvider({ default: mockTextModel('echoed') }),
  server: { port: 41999 },
})
