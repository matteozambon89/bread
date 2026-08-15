import { defineConfig } from '@bread/core'
import { store } from '@bread/store-memory'
import { transport } from '@bread/transport-stdout'
import { mockProvider, mockTextModel } from '@bread/test-utils'

// Fixture for packages/cli/test's non-interactive binary tests (--cwd
// resolution, stdin piping, exit codes) via `bread invoke` against a
// scripted, always-succeeds text model.
export default defineConfig({
  entrypoints: ['echo'],
  store: store(),
  transport: transport(),
  providers: mockProvider({ default: mockTextModel('echoed') }),
})
