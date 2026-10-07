<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/provider-catalog

Compatibility re-export of [`@breadai/provider-llm`](https://github.com/matteozambon89/bread/tree/HEAD/providers/llm),
the successor of this package. New code should depend on `@breadai/provider-llm`.

`providerCatalog` and `CatalogEntry` stay exported, so a `>=0.1.0 <1.0.0` upgrade does not break
existing imports. `providerLlm` and `providerEntries` are exported as well:

```ts
import {
  providerCatalog,
  providerEntries,
  providerLlm,
  type CatalogEntry,
} from '@breadai/provider-catalog'
```

Prefer the successor directly:

```bash
bun add @breadai/provider-llm
```

```ts
import { providerLlm } from '@breadai/provider-llm'

export default defineConfig({
  providers: providerLlm,
})
```

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [providers](https://matteozambon89.github.io/bread/providers.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
