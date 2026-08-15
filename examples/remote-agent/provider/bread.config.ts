import { defineConfig } from '@bread/core'
import { authStrategy } from '@bread/auth-api-key'
import { providerCatalog } from '@bread/provider-catalog'
import { authPlugin } from '@bread/server'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

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
