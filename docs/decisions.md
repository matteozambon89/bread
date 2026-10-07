# Decisions

A pipeline step can ask a System One host for a label. The host sees the current pipeline value.
The step-end crumb records the label. The value passed to the next step stays the pre-decision
value, so a following agent still receives the input it already accepts.

```ts
{
  type: 'decision',
  provider: 'typesafe',
  model: 'jev-latest',
  question: {
    type: 'choice',
    text: 'Which desk owns this message?',
    options: ['billing', 'shipping'],
    otherwise: 'needs_review',
    minConfidence: 0.8,
  },
}
```

`pipeline:step:start` and `pipeline:step:end` use `agentId: 'decision'`. The end crumb's `output`
is `{ label, answer }`, where `answer` is the host answer the step judged. [`examples/decision`](https://github.com/matteozambon89/bread/tree/HEAD/examples/decision)
is one decision step and then an agent whose input is still the original string.

## Questions

One question per step. `min`, `max`, `otherwise`, and `minConfidence` stay in the step. The host
receives the question text, and for a choice the option labels.

| Type | Label |
|------|--------|
| `choice` | The returned choice when it is one of `options`. `otherwise` is required. Confidence may be absent only when `minConfidence` is unset. Below `minConfidence`, a missing or non-finite confidence when `minConfidence` is set, or a choice outside `options`, writes `otherwise`. A confidence equal to `minConfidence` passes. |
| `score` | The one inclusive bucket (`value >= min && value <= max`) that contains the host's `score`. |
| `noul` | The one inclusive bucket that contains the host's probability. |

Zero matching buckets, or two, throws `DECISION_BUCKET` before later steps run. A missing answer,
the wrong answer type, or a missing number throws `DECISION_ANSWER`.

## Registry

`BreadConfig.decisions` is a `DecisionRegistry`: `Record<string, (modelId: string) => DecisionClient | Promise<DecisionClient>>`.
The step passes `model` into the factory. The client exposes `systemOne({ state, questions })`.
Core has no built-in hosts. An unset registry throws `DECISION_NOT_CONFIGURED`. An unknown name,
including a name missing from an empty registry, throws `UNKNOWN_DECISION_PROVIDER`. Both throw
before later steps run.

[`@breadai/provider-decisions`](https://github.com/matteozambon89/bread/tree/HEAD/providers/decisions)
exports `providerDecisions` for that field. Importing it does not call a host. The keys are
`typesafe`, `kev`, `liquid`, `decider`, `ollama`, `strands`, `cloudflare`, and `perplexity`.
OpenRouter and the Vercel AI Gateway are `TYPESAFE_BASE_URL` on `typesafe`, not extra keys.
`cloudflare` and `perplexity` are adapters. Together's native API is not a host. A missing
required variable throws `PROVIDER_NOT_CONFIGURED` before the request. An HTTP error throws
`DECISION_HOST`.

Score questions are sent with a fixed rubric `"0"` through `"9"`. Bucket ranges are applied to
that number in the step, not sent to the host. Decider's README allows 2–255 choice labels and
caps score at 10 levels. `decider` and `strands` both default to `http://127.0.0.1:8000`.
