import { join } from 'node:path'
import { beforeEach, expect, spyOn, test } from 'bun:test'
import { BreadError, type BreadStore } from '@breadai/core'
import { runMigrate } from '@breadai/server'
import { store } from '@breadai/store-memory'

const projectRoot = join(import.meta.dir, 'fixtures', 'migrate-project')

// loadConfig cache-busts with the current millisecond, so two calls can share
// one module. Mutate this object instead of replacing it.
const backend = store()
const calls: string[] = []
let fail = false
backend.migrate = async () => {
  calls.push('migrate')
  if (fail) {
    throw new BreadError('Migration 0001_baseline failed.', 'MIGRATION_FAILED', { step: '0001_baseline' })
  }
  return { applied: ['0001_baseline'], skipped: ['0002_vector'] }
}
backend.migrations = async () => {
  calls.push('check')
  return { pending: ['0001_baseline'] }
}
backend.close = async () => {
  calls.push('close')
}
;(globalThis as Record<string, unknown>)['__breadMigrateTestStore'] = backend

const fixed = backend as BreadStore

beforeEach(() => {
  calls.length = 0
  fail = false
  fixed.migrate = backend.migrate
  fixed.migrations = backend.migrations
  fixed.close = backend.close
})

test('migrate applies even when server.migrate is false, prints ids, and closes', async () => {
  const logSpy = spyOn(console, 'log')
  try {
    await runMigrate({ cwd: projectRoot })
    expect(calls).toEqual(['migrate', 'close'])
    expect(logSpy.mock.calls.map((call) => call.join(' '))).toEqual([
      'applied 0001_baseline',
      'skipped 0002_vector',
    ])
  } finally {
    logSpy.mockRestore()
  }
})

test('a failed step still closes and does not print ids', async () => {
  fail = true
  const logSpy = spyOn(console, 'log')
  try {
    await expect(runMigrate({ cwd: projectRoot })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })
    expect(calls).toEqual(['migrate', 'close'])
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')).not.toContain('applied')
  } finally {
    logSpy.mockRestore()
  }
})
