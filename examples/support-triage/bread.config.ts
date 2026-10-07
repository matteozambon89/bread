import { defineConfig } from '@breadai/core'
import { agUi } from '@breadai/protocol-ag-ui'
import { providerDecisions } from '@breadai/provider-decisions'
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
  decisions: providerDecisions,
  pipelines: {
    refund: [
      { type: 'agent', agentId: 'ticket-lookup' },
      {
        type: 'decision',
        provider: 'typesafe',
        model: 'jev-latest',
        question: {
          type: 'choice',
          text: 'How should this refund be routed?',
          options: ['needs_review', 'auto_refund', 'deny'],
          otherwise: 'needs_review',
        },
      },
      {
        type: 'branch',
        cases: [
          { eq: 'needs_review', steps: [{ type: 'agent', agentId: 'investigator' }] },
          { eq: 'auto_refund', steps: [{ type: 'agent', agentId: 'policy-check' }] },
          { eq: 'deny', steps: [{ type: 'agent', agentId: 'policy-check' }] },
        ],
        default: [{ type: 'agent', agentId: 'investigator' }],
      },
    ],
  },
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
