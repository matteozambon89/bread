import { BreadError } from '@bread/core'
import type { BreadStore } from '@bread/core'
import { loadConfig } from '../loader.js'

export interface SessionListOptions {
  cwd: string
  tag?: string
}

export interface SessionCleanupOptions {
  cwd: string
  olderThanDays?: number
  tag?: string
}

// Session commands run non-interactively (often scripted), so they don't prompt
// for setup — they require a store to already be configured.
async function requireStore(cwd: string): Promise<BreadStore> {
  const { store } = await loadConfig(cwd)
  if (!store) {
    throw new BreadError(
      "No store configured. Set `store` in bread.config.ts — e.g. `store({ path: './bread.db' })` " +
        "from `@bread/store-sqlite`, or `store()` from `@bread/store-postgres` (reads DATABASE_URL).",
      'STORE_NOT_CONFIGURED',
    )
  }
  return store
}

function parseTag(tag: string | undefined): Record<string, string> | undefined {
  if (!tag) return undefined
  const [k, v] = tag.split('=')
  if (!k || v === undefined) {
    console.error('[bread] --tag must be in key=value format')
    return undefined
  }
  return { [k]: v }
}

export async function listSessions(opts: SessionListOptions): Promise<void> {
  const store = await requireStore(opts.cwd)
  const tags = parseTag(opts.tag)
  const list = await store.listSessions(tags ? { tags } : undefined)

  if (list.length === 0) {
    console.log('[bread] No sessions found')
    return
  }

  console.log(`\nSessions (${list.length}):\n`)
  for (const s of list) {
    const tagsStr = Object.entries(s.tags).map(([k, v]) => `${k}=${v}`).join(', ')
    console.log(`  ${s.id}  updated=${new Date(s.updatedAt).toISOString()}${tagsStr ? `  tags=${tagsStr}` : ''}`)
  }
}

export async function cleanupSessions(opts: SessionCleanupOptions): Promise<void> {
  const store = await requireStore(opts.cwd)
  const tags = parseTag(opts.tag)
  const olderThanMs = opts.olderThanDays ? opts.olderThanDays * 24 * 60 * 60 * 1000 : undefined
  const count = await store.cleanupSessions({
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
    ...(tags ? { tags } : {}),
  })
  console.log(`[bread] Deleted ${count} session(s)`)
}
