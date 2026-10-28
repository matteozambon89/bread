# knowledge-graph

Run the agent twice in the same session: the second run receives KG context from the first.

Document and knowledge writes embed with local `ollama` (`nomic-embed-text`, optional `OLLAMA_BASE_URL`) and store the vectors in Postgres (`DATABASE_URL`). The model is resolved from `config.embeddings` on each write, so a missing provider fails the write instead of storing text only.
