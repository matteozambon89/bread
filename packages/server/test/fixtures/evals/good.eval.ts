import { defineEval } from '@bread/core'

export default defineEval({
  agentId: 'greeter',
  cases: [{ name: 'basic', input: 'hi', scorers: [{ type: 'contains', expected: 'hi' }] }],
})
