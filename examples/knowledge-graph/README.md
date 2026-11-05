# knowledge-graph

Run the agent twice in the same session: the second run receives KG context from the first.

Document ingest, document search, knowledge-node writes, and knowledge queries use an embedding ref (`ollama` / `nomic-embed-text`, optional `OLLAMA_BASE_URL`) resolved from `config.embeddings` on those operations, not when this module is imported. Vectors are stored in Postgres (`DATABASE_URL`). A missing provider fails the operation instead of storing text only.
