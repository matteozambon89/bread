import assert from 'node:assert/strict'
import { afterAll, beforeAll, afterEach, test } from 'bun:test'
import type { CrumbLogEntry } from '@breadai/core'
import { store } from '@breadai/store-postgres'
import { type PgliteHandle, withPglite } from '@breadai/test-utils'

// STA-03: appendCrumbs must be all-or-nothing. A batch where one entry
// violates a constraint (here: an FK to a nonexistent session) must leave no
// entries persisted, not just the offending one.
const realUrl = process.env.BREAD_TEST_DATABASE_URL

let pg: PgliteHandle | undefined
let url: string

beforeAll(async () => {
  url = realUrl ?? (pg = await withPglite()).url
  const s = store({ url })
  await s.migrate?.()
  await s.close?.()
})

afterEach(async () => {
  if (pg) await pg.truncate()
})

afterAll(async () => {
  await pg?.close()
})

function crumbEntry(runId: string, seq: number, over: Partial<CrumbLogEntry> = {}): CrumbLogEntry {
  return {
    runId,
    seq,
    sessionId: 's1',
    type: 'text:delta',
    crumb: { type: 'text:delta', agentId: 'a', runId, sessionId: 's1', timestamp: 1, delta: `d${seq}`, seq },
    createdAt: Date.now(),
    ...over,
  }
}

test('appendCrumbs rolls back the whole batch when one entry fails mid-way', async () => {
  const s = store({ url })
  await s.createSession({ id: 's1' })

  const batch = [
    crumbEntry('r1', 1),
    // Violates the session_id FK — no session 'does-not-exist' exists.
    crumbEntry('r1', 2, { sessionId: 'does-not-exist' }),
    crumbEntry('r1', 3),
  ]

  await assert.rejects(s.appendCrumbs!(batch))
  assert.deepEqual(await s.getCrumbs!('r1'), [])

  await s.close?.()
})
