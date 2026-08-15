# Evals

Evals are regression tests for agents. Put `*.eval.ts` files under `agents/<id>/evals/` and run them
with `bread eval`.

```ts
// agents/writer/evals/quality.eval.ts
import { defineEval } from '@bread/core'

export default defineEval({
  agentId: 'writer',
  type: 'functional',
  cases: [
    {
      name: 'mentions the topic',
      input: { topic: 'sourdough' },
      scorers: [
        { type: 'contains', expected: 'sourdough' },
        { type: 'regex', pattern: '\\b(starter|levain)\\b' },
      ],
    },
    {
      name: 'is genuinely helpful',
      input: { topic: 'sourdough' },
      scorers: [
        { type: 'llmJudge', prompt: 'Is this a clear, accurate explanation for a beginner?' },
      ],
    },
  ],
})
```

```bash
bread eval                       # all evals
bread eval agents/writer         # scoped to a path
```

## Scorer types

| Scorer | Passes when |
|--------|-------------|
| `exact` | Output equals `expected`. |
| `contains` | Output contains `expected`. |
| `regex` | Output matches `pattern`. |
| `llmJudge` | A judge model answers yes to `prompt`. Optional per-scorer `model`. |
| `custom` | `fn(output)` returns truthy. |

## Eval types

`type` tags the suite: `functional` (default), `prompt-injection`, `jailbreak`,
`data-exfiltration` — useful for separating capability tests from security tests.

## The judge model

`llmJudge` uses, in order: `BREAD_EVAL_MODEL` env var → the scorer's `model` → `openai/gpt-4o-mini`.

```bash
BREAD_EVAL_MODEL=anthropic/claude-opus-4-8 bread eval
```
