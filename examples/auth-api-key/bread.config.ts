import { defineConfig } from '@breadai/core'
import { authStrategy } from '@breadai/auth-api-key'
import { providerCatalog } from '@breadai/provider-catalog'
import { authPlugin } from '@breadai/server'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// Every route now requires `Authorization: Bearer $BREAD_API_KEY`.
export default defineConfig({
  entrypoints: ['greeter'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
  plugins: [
    authPlugin([
      authStrategy({
        scheme: 'Bearer',
        keys: [process.env.BREAD_API_KEY ?? 'dev-key'],
      }),
    ]),
  ],
})
