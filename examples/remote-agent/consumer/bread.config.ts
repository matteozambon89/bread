import { defineConfig } from '@breadai/core'
import { signer } from '@breadai/auth-api-key'
import { providerCatalog } from '@breadai/provider-catalog'
import { store } from '@breadai/store-sqlite'
import { remoteAgent, transport } from '@breadai/transport-http-chunked'

// The consumer: `researcher` is NOT a local agent — it dispatches over HTTP to
// the provider (see ../provider), signed per request with the shared API key.
// `transport` here is this app's own ingress (bread dev serves `planner`
// locally); it is unrelated to remoteAgent's outgoing call to the provider.
export default defineConfig({
  entrypoints: ['planner'],
  store: store({ path: './.consumer.db' }),
  transport: transport(),
  providers: providerCatalog,
  remoteAgents: {
    researcher: remoteAgent({
      url: process.env.RESEARCH_URL ?? 'http://localhost:4001',
      signer: signer({
        scheme: 'Bearer',
        keys: [process.env.RESEARCH_TOKEN ?? 'dev-key'],
      }),
    }),
  },
})
