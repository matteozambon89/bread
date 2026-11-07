# custom-embed

Postgres (`DATABASE_URL`) with a custom `embed` function. The function is not an `{ provider, model }` ref and it does not read `config.embeddings`. Importing this module does not run it.

The function builds a deterministic vector and then throws `stop before sql`, so a write fails before a query. Return the vector to store it.

```bash
DATABASE_URL=postgres://localhost:5432/bread bun install && bread dev
```
