import { defineConfig } from '@bread/core'
import { a2ui } from '@bread/a2ui'
import { providerCatalog } from '@bread/provider-catalog'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

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
