import { defineConfig } from '@bread/core'
import { authStrategy } from '@bread/auth-api-key'
import { providerCatalog } from '@bread/provider-catalog'
import { authPlugin } from '@bread/server'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

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
