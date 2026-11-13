# knowledge-graph

Run the agent twice in the same session. Memories are not pasted into the next run; the agent recalls them with the memory tools.

Document ingest, document search, memory write, and memory search use an embedding ref (`ollama` / `nomic-embed-text`, optional `OLLAMA_BASE_URL`) resolved from `config.embeddings` on those operations, not when this module is imported. Vectors are stored in Postgres (`DATABASE_URL`). A missing provider fails the operation instead of storing text only. SQLite is not the store here. `doc_extract_entities` returns names and does not store them.
