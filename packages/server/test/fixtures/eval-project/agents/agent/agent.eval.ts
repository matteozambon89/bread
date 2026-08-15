import { defineEval } from '@breadai/core'

// One passing case (exact match) and one failing case — exercises both the
// pass and fail branches of `bread eval`'s summary in a single suite.
export default defineEval({
  agentId: 'agent',
  cases: [
    { name: 'matches', input: 'hi', scorers: [{ type: 'exact', expected: 'agent output' }] },
    { name: 'mismatches', input: 'hi', scorers: [{ type: 'exact', expected: 'not what the agent says' }] },
  ],
})
