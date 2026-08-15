import { defineEval } from '@bread/core'

export default defineEval({
  agentId: 'writer',
  type: 'functional',
  cases: [
    {
      name: 'mentions the topic',
      input: 'sourdough',
      scorers: [
        { type: 'contains', expected: 'sourdough' },
        { type: 'llmJudge', prompt: 'Is this a clear beginner explanation?' },
      ],
    },
  ],
})
