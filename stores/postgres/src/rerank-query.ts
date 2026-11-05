import { RERANK_DOCUMENT_CAP } from '@breadai/core'

// Extra retrieval hits per requested hit, still under the provider document cap.
const RERANK_WINDOW_MULTIPLE = 4

export function candidateLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(Math.floor(limit) * RERANK_WINDOW_MULTIPLE, RERANK_DOCUMENT_CAP)
}

// `%` and `_` stay literals. Callers add ESCAPE '\'.
export function likeContains(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

// The keyword predicate matches title or body. Scoring the body alone drops a
// title hit, and an empty body makes the provider reject the search.
export function documentRerankText(row: { title: string; content: string }): string {
  const title = row.title.trim()
  const content = row.content.trim()
  if (title.length === 0) return content
  if (content.length === 0) return title
  return `${title}\n${content}`
}
