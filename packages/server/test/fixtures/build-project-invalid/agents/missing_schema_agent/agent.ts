import { defineAgent } from '@bread/core'

// Deliberately typed away with `as never` — hits runBuild's missing
// inputSchema/outputSchema branches, which loadAgents itself never validates.
export default defineAgent({
  model: { provider: 'openai', model: 'gpt-4o-mini' },
  inputSchema: undefined as never,
  outputSchema: undefined as never,
  output: { format: 'text' },
})
