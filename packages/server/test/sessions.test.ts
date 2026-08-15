import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { BreadStore } from '@bread/core'
import { cleanupSessions, listSessions } from '@bread/server'
import { store } from '@bread/store-memory'

const projectRoot = join(import.meta.dir, 'fixtures', 'sessions-project')
const noStoreRoot = join(import.meta.dir, 'fixtures', 'sessions-project-no-store')

// loadConfig re-imports bread.config.ts with a `?t=${Date.now()}` cache-buster
// per call — fast successive test calls can land in the same millisecond and
// hit Bun's module cache, so the fixture's `config.store` binds to whatever
// `globalThis.__breadSessionsTestStore` *object identity* existed at that
// (possibly reused) import. Keeping one persistent object and resetting its
// behavior in place (rather than swapping in a new object each test) sidesteps
// that entirely.
const testStore: BreadStore = store()
;(globalThis as Record<string, unknown>)['__breadSessionsTestStore'] = testStore

describe('sessions commands', () => {
  beforeEach(() => {
    Object.assign(testStore, store())
  })

  test('requireStore (via listSessions) throws STORE_NOT_CONFIGURED when store is unset', async () => {
    await expect(listSessions({ cwd: noStoreRoot })).rejects.toThrow(/No store configured/)
  })

  test('requireStore (via cleanupSessions) throws STORE_NOT_CONFIGURED when store is unset', async () => {
    await expect(cleanupSessions({ cwd: noStoreRoot })).rejects.toThrow(/No store configured/)
  })

  test('listSessions with an empty store prints "No sessions found"', async () => {
    const logSpy = spyOn(console, 'log')
    await listSessions({ cwd: projectRoot })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('No sessions found')
    logSpy.mockRestore()
  })

  test('listSessions converts a well-formed --tag into a store filter', async () => {
    let received: { tags?: Record<string, string> } | undefined
    testStore.listSessions = async (filter) => {
      received = filter
      return []
    }

    await listSessions({ cwd: projectRoot, tag: 'env=prod' })
    expect(received).toEqual({ tags: { env: 'prod' } })
  })

  test('a malformed --tag logs an error and queries with no tag filter', async () => {
    let received: { tags?: Record<string, string> } | undefined
    testStore.listSessions = async (filter) => {
      received = filter
      return []
    }
    const errorSpy = spyOn(console, 'error')

    await listSessions({ cwd: projectRoot, tag: 'not-a-kv-pair' })

    expect(received).toBeUndefined()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('--tag must be in key=value format')
    errorSpy.mockRestore()
  })

  test('cleanupSessions converts olderThanDays and --tag into the store options', async () => {
    let received: unknown
    testStore.cleanupSessions = async (opts) => {
      received = opts
      return 3
    }
    const logSpy = spyOn(console, 'log')

    await cleanupSessions({ cwd: projectRoot, olderThanDays: 7, tag: 'env=prod' })

    expect(received).toEqual({ olderThanMs: 7 * 24 * 60 * 60 * 1000, tags: { env: 'prod' } })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Deleted 3 session(s)')
    logSpy.mockRestore()
  })

  test('cleanupSessions with no options passes an empty filter', async () => {
    let received: unknown
    testStore.cleanupSessions = async (opts) => {
      received = opts
      return 0
    }

    await cleanupSessions({ cwd: projectRoot })
    expect(received).toEqual({})
  })

  test('listSessions/cleanupSessions actually round-trip through a real store-memory instance', async () => {
    await testStore.createSession({ tags: { env: 'prod' } })
    const logSpy = spyOn(console, 'log')

    await listSessions({ cwd: projectRoot })
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Sessions (1)')

    logSpy.mockRestore()
    await cleanupSessions({ cwd: projectRoot, tag: 'env=prod' })
    // No olderThanDays given: cleanupSessions is a no-op regardless of tag match.
    expect(await testStore.listSessions()).toHaveLength(1)
  })
})
