import { defineConfig } from '@breadai/core'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-stdout'
import { mockProvider, mockTextModel } from '@breadai/test-utils'

// Fixture for packages/cli/test's non-interactive binary tests (--cwd
// resolution, stdin piping, exit codes) via `bread invoke` against a
// scripted, always-succeeds text model.
export default defineConfig({
  entrypoints: ['echo'],
  store: store(),
  transport: transport(),
  providers: mockProvider({ default: mockTextModel('echoed') }),
})
