import { defineConfig } from '@breadai/core'
import { authStrategy } from '@breadai/auth-api-key'
import { providerCatalog } from '@breadai/provider-catalog'
import { authPlugin } from '@breadai/server'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// The provider: serves `researcher` behind an API-key gate. The consumer's
// remoteAgent() signs its requests with the same strategy — see ../consumer.
export default defineConfig({
  entrypoints: ['researcher'],
  store: store({ path: './.provider.db' }),
  transport: transport(),
  providers: providerCatalog,
  plugins: [
    authPlugin([
      authStrategy({
        scheme: 'Bearer',
        keys: [process.env.RESEARCH_TOKEN ?? 'dev-key'],
      }),
    ]),
  ],
})
