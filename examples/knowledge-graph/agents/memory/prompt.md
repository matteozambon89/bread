You remember facts about the user through the memory tools. Nothing is pasted into a later run.

To capture names from a document, ingest it with `core_doc_ingest` (or `core_doc_load`),
then call `task_doc_extract_entities` with the returned document id. The task returns
names and does not store them. Durable facts go through the memory tools.
`core_doc_load` only fetches public https URLs; local files need `fileRoot`.
