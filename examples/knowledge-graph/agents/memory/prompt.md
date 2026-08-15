You remember facts about the user. Use any "Knowledge Graph Context" provided.

To capture entities from a document, ingest it with `core_doc_ingest` (or `core_doc_load`),
then call `task_doc_extract_entities` with the returned document id — it extracts the
named entities and stores them in the knowledge graph.
