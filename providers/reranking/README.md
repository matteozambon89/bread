<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-reranking

Reranking providers as a `RerankingRegistry` for `config.reranking`. Each factory is imported
lazily and returns an AI SDK `RerankingModel` from `.reranking(modelId)`. Installing this package
does not pull in every SDK — you still `bun add` only the ones you use.

```bash
bun add @breadai/provider-reranking
bun add @ai-sdk/cohere   # only the providers you use
```

```ts
import { defineConfig } from '@breadai/core'
import { providerReranking } from '@breadai/provider-reranking'
import { store } from '@breadai/store-postgres'

export default defineConfig({
  entrypoints: ['memory'],
  reranking: providerReranking,
  store: store({
    rerank: { provider: 'cohere', model: 'rerank-v3.5' },
  }),
})
```

Do not put this on `config.providers`. That registry returns a `LanguageModel`.

| Key | Call | Auth |
| --- | --- | --- |
| `cohere` | `cohere.reranking(modelId)` from `@ai-sdk/cohere` | `COHERE_API_KEY` |
| `amazon-bedrock` | `bedrock.reranking(modelId)` from `@ai-sdk/amazon-bedrock` | `AWS_REGION`, plus `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_BEARER_TOKEN_BEDROCK` |
| `togetherai` | `togetherai.reranking(modelId)` from `@ai-sdk/togetherai` | `TOGETHER_API_KEY` |
| `voyage` | `voyage.reranking(modelId)` from `@ai-sdk/voyage` | `VOYAGE_API_KEY` |

`openai-compatible` is not a key. The AI SDK has no reranking factory for it.

`bread.start()` binds this registry onto a Postgres store. With `rerank: { provider, model }`,
`searchDocuments` and `queryKnowledge` load candidate text (document content, knowledge label),
reorder those hits, and then apply `limit`. With no `rerank` ref, order is unchanged. SQLite and
memory stay keyword-only.
[`examples/knowledge-graph`](https://github.com/matteozambon89/bread/tree/HEAD/examples/knowledge-graph)
uses SQLite, so its `core_doc_search` and `core_kg_query` order is unchanged. A missing peer throws
`MISSING_PROVIDER` with the `bun add` command. Spreading `providerReranking` does not import the peers.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [providers](https://matteozambon89.github.io/bread/providers.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
