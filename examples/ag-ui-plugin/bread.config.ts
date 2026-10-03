import { defineConfig } from '@breadai/core'
import { agUi } from '@breadai/protocol-ag-ui'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  plugins: [
    // In a real frontend integration this handler forwards each event to the
    // AG-UI client transport (WebSocket/SSE); here it logs the event stream so
    // the mapping is visible: RUN_STARTED, TEXT_MESSAGE_START/CONTENT/END
    // framing, TOOL_CALL_* lifecycles, RUN_FINISHED.
    agUi({
      onEvent: (event) => {
        console.log(`[ag-ui] ${event.type}`, JSON.stringify(event))
      },
    }),
  ],
})
