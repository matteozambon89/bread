<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-decisions

System One hosts as a `DecisionRegistry` for `config.decisions`. Each factory is lazy: importing this package does not construct a client or call a host.

```bash
bun add @breadai/provider-decisions
```

```ts
import { defineConfig } from '@breadai/core'
import { providerDecisions } from '@breadai/provider-decisions'

export default defineConfig({
  entrypoints: ['reply'],
  decisions: providerDecisions,
})
```

Core does not ship these hosts. A decision step names one key below and passes `model` into that factory.

| Key | Call | Auth |
| --- | --- | --- |
| `typesafe` | `POST {base}/v1/systemone` via `@typesafe-ai/sdk`. Default base `https://api.typesafe.ai`. | `TYPESAFE_API_KEY`. Optional `TYPESAFE_BASE_URL`. |
| `kev` | SDK against `http://127.0.0.1:8009` (`python -m kev.serve --port 8009`). | Bearer `KEV_API_KEY`, or `local` when the server is open. Optional `KEV_BASE_URL`. |
| `liquid` | SDK against `https://api.liquid.ai/decisions` (`POST /decisions/v1/systemone`). Documented model id `d1:free`. | `LIQUID_API_KEY`. |
| `decider` | SDK against `http://127.0.0.1:8000` (`scripts/serve.sh`, no auth). | Placeholder bearer `local`. Does not read `TYPESAFE_BASE_URL`. |
| `ollama` | SDK against `http://localhost:11434`. README model ids include `nimble` and `tev1`. | Placeholder bearer `ollama`. Local requests need no key. |
| `strands` | SDK against `http://127.0.0.1:8000` (`strands-decider serve --port 8000`). | Placeholder bearer `local`. |
| `cloudflare` | `POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/<model>`. Not the SDK path. | `CLOUDFLARE_ACCOUNT_ID`. `CLOUDFLARE_AUTH_TOKEN`, or `CLOUDFLARE_API_TOKEN` when the auth token is unset. |
| `perplexity` | `POST https://api.perplexity.ai/v1/decisions`. Not the SDK path. Model `pplx-decider-v1-27b`. | `PERPLEXITY_API_KEY`. |

OpenRouter and the Vercel AI Gateway are the `typesafe` entry with `TYPESAFE_BASE_URL` set. OpenRouter's docs use `https://openrouter.ai/api` (the SDK appends `/v1/systemone`) and an OpenRouter key in `TYPESAFE_API_KEY`. Vercel's TypeSafe-compatible API uses `https://ai-gateway.vercel.sh/typesafe` and the gateway key (`AI_GATEWAY_API_KEY`) as that same `TYPESAFE_API_KEY`. They are not separate registry keys. Together's native API is not a host.

`decider` and `strands` both default to port 8000. Run one, or point only one of them at a different server before using both. Decider's README allows choice questions of 2–255 labels and caps score at 10 levels.

Score questions are sent with a fixed rubric `"0"` through `"9"`. The host's `score` is a number on that 0–9 scale. Bucket `min`/`max` stay in the pipeline step and are not part of the request. Choice options are sent as undescribed labels. Noul is the question text only; a host `noul` probability is what the pipeline buckets.

A missing required variable throws `PROVIDER_NOT_CONFIGURED` before any request. An HTTP error from the host throws `DECISION_HOST`.
