import { defineEval } from '@bread/core'

export default defineEval({
  agentId: 'greeter',
  cases: [{ name: 'nested', input: 'yo', scorers: [{ type: 'contains', expected: 'yo' }] }],
})
