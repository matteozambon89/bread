import { defineConfig } from '@breadai/core'
import { agUi } from '@breadai/protocol-ag-ui'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// `triage-supervisor` is the only entrypoint a client calls directly; `investigator`,
// `ticket-lookup`, and `policy-check` still need to be registered because the runner
// resolves delegation/loop-pool ids against the same registry.
export default defineConfig({
  entrypoints: ['triage-supervisor', 'investigator', 'ticket-lookup', 'policy-check'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  plugins: [
    // Same logging bridge as examples/ag-ui-plugin — in a real frontend this forwards
    // to the AG-UI client transport instead.
    agUi({
      onEvent: (event) => {
        console.log(`[ag-ui] ${event.type}`, JSON.stringify(event))
      },
    }),
  ],
})
