import { defineConfig } from '@breadai/core'
import { a2ui } from '@breadai/a2ui'
import { providerCatalog } from '@breadai/provider-catalog'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
  plugins: [
    // In a real frontend integration this handler forwards each spec to the
    // A2UI client renderer; here it logs the computed spec so the crumb→spec
    // mapping is visible: progress/markdown/card/form/error/file components
    // derived from agent:run:start, text:delta, tool:call, human:required, etc.
    a2ui({
      onSpec: (spec, crumb) => {
        console.log(`[a2ui] ${crumb.type}`, JSON.stringify(spec))
      },
    }),
  ],
})
