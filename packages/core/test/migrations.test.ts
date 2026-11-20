import { describe, expect, test } from 'bun:test'
import {
  BreadError,
  migrationChecksum,
  readMigrationStatus,
  redactConnectionSecrets,
  runMigrations,
  type AppliedMigration,
  type MigrationJournal,
  type MigrationStep,
} from '@breadai/core'

const CHECKSUM = migrationChecksum('create table one')
const CHECKSUM_TWO = migrationChecksum('create table two')

function step(id: string, checksum = id === '0001_baseline' ? CHECKSUM : CHECKSUM_TWO, ups?: string[]): MigrationStep {
  return {
    id,
    checksum,
    up: async () => {
      ups?.push(id)
    },
  }
}

class FakeJournal implements MigrationJournal {
  rows: AppliedMigration[] = []
  locked = false
  ensureCalls = 0
  mode: 'ok' | 'missing' | 'forbidden' = 'ok'
  failLock = false
  conflict = false

  async lock() {
    if (this.failLock) throw new BreadError('Could not acquire the migration lock.', 'MIGRATION_LOCK', {})
    this.locked = true
    let released = false
    const release = async () => {
      if (released) return
      released = true
      this.locked = false
    }
    return { commit: release, rollback: release }
  }

  async applied() {
    if (!this.locked) throw new Error('applied outside the lock')
    if (this.mode === 'missing') {
      throw new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {})
    }
    if (this.mode === 'forbidden') {
      throw new BreadError('Migration journal could not be read.', 'MIGRATION_JOURNAL_FORBIDDEN', {})
    }
    return this.rows.map((row) => ({ ...row }))
  }

  async ensure() {
    if (!this.locked) throw new Error('ensure outside the lock')
    this.ensureCalls++
    if (this.mode === 'missing') this.mode = 'ok'
  }

  async record(id: string, checksum: string) {
    if (!this.locked) throw new Error('record outside the lock')
    if (this.conflict || this.rows.some((row) => row.id === id)) return false
    this.rows.push({ id, checksum })
    return true
  }
}

function codeOf(err: unknown): string {
  expect(err).toBeInstanceOf(BreadError)
  return (err as BreadError).code
}

describe('migration journal', () => {
  test('redacts userinfo and password parameters', () => {
    const text = redactConnectionSecrets(
      'failed postgres://app:s3cret@db.example:5432/app?sslmode=require&password=s3cret',
    )
    expect(text).not.toContain('s3cret')
    expect(text).not.toContain('app:')
    expect(text).toContain('db.example')
    expect(text).toContain('sslmode=require')
  })

  test('applies pending steps once and then skips them', async () => {
    const journal = new FakeJournal()
    journal.mode = 'missing'
    const ups: string[] = []
    const steps = [step('0001_baseline', CHECKSUM, ups), step('0002_next', CHECKSUM_TWO, ups)]
    const first = await runMigrations(journal, steps, [])
    expect(first).toEqual({ applied: ['0001_baseline', '0002_next'], skipped: [] })
    expect(ups).toEqual(['0001_baseline', '0002_next'])
    expect(journal.ensureCalls).toBe(1)
    expect(journal.locked).toBe(false)
    expect(journal.rows.map((row) => row.checksum)).toEqual([CHECKSUM, CHECKSUM_TWO])

    const second = await runMigrations(journal, steps, [])
    expect(second).toEqual({ applied: [], skipped: ['0001_baseline', '0002_next'] })
    expect(ups).toEqual(['0001_baseline', '0002_next'])
    const status = await readMigrationStatus(journal, steps, [])
    expect(status).toEqual({ pending: [] })
  })

  test('a checksum mismatch does not run up or rewrite the row', async () => {
    const journal = new FakeJournal()
    journal.rows = [{ id: '0001_baseline', checksum: migrationChecksum('previous text') }]
    const ups: string[] = []
    await expect(runMigrations(journal, [step('0001_baseline', CHECKSUM, ups)], [])).rejects.toMatchObject({
      code: 'MIGRATION_CHANGED',
    })
    expect(ups).toEqual([])
    expect(journal.rows[0]!.checksum).toBe(migrationChecksum('previous text'))
    expect(journal.locked).toBe(false)
  })

  test('an unknown applied id is ahead', async () => {
    const journal = new FakeJournal()
    journal.rows = [{ id: '0009_future', checksum: CHECKSUM }]
    await expect(runMigrations(journal, [step('0001_baseline')], [])).rejects.toMatchObject({
      code: 'MIGRATION_AHEAD',
    })
  })

  test('a known optional id is not ahead and a hole is', async () => {
    const journal = new FakeJournal()
    journal.rows = [{ id: '0002_vector', checksum: 'not-compared' }]
    const ups: string[] = []
    const report = await runMigrations(journal, [step('0001_baseline', CHECKSUM, ups)], ['0002_vector'])
    expect(report.applied).toEqual(['0001_baseline'])
    expect(ups).toEqual(['0001_baseline'])

    const hole = new FakeJournal()
    hole.rows = [{ id: '0002_next', checksum: CHECKSUM_TWO }]
    await expect(
      runMigrations(hole, [step('0001_baseline'), step('0002_next')], []),
    ).rejects.toMatchObject({ code: 'MIGRATION_AHEAD' })
  })

  test('a record conflict fails the run', async () => {
    const journal = new FakeJournal()
    journal.conflict = true
    const ups: string[] = []
    await expect(runMigrations(journal, [step('0001_baseline', CHECKSUM, ups)], [])).rejects.toMatchObject({
      code: 'MIGRATION_CONFLICT',
    })
    expect(ups).toEqual(['0001_baseline'])
    expect(journal.rows).toEqual([])
    expect(journal.locked).toBe(false)
  })

  test('a missing journal on the check path is pending and does not ensure', async () => {
    const journal = new FakeJournal()
    journal.mode = 'missing'
    await expect(readMigrationStatus(journal, [step('0001_baseline')], [])).rejects.toMatchObject({
      code: 'MIGRATIONS_PENDING',
      context: { reason: 'missing_journal' },
    })
    expect(journal.ensureCalls).toBe(0)
    expect(journal.locked).toBe(false)
  })

  test('a permission error is not success', async () => {
    const journal = new FakeJournal()
    journal.mode = 'forbidden'
    await expect(readMigrationStatus(journal, [step('0001_baseline')], [])).rejects.toMatchObject({
      code: 'MIGRATION_JOURNAL_FORBIDDEN',
    })
    expect(journal.ensureCalls).toBe(0)
  })

  test('a lock that is not acquired does not apply', async () => {
    const journal = new FakeJournal()
    journal.failLock = true
    const ups: string[] = []
    await expect(runMigrations(journal, [step('0001_baseline', CHECKSUM, ups)], [])).rejects.toMatchObject({
      code: 'MIGRATION_LOCK',
    })
    expect(journal.ensureCalls).toBe(0)
    expect(ups).toEqual([])
  })

  test('rejects duplicate and unsorted step lists before locking', async () => {
    const journal = new FakeJournal()
    journal.failLock = true
    await expect(runMigrations(journal, [step('0002_next'), step('0001_baseline')], [])).rejects.toMatchObject({
      code: 'MIGRATION_INVALID',
    })
    await expect(runMigrations(journal, [step('0001_baseline'), step('0001_baseline')], [])).rejects.toMatchObject({
      code: 'MIGRATION_INVALID',
    })
    expect(journal.locked).toBe(false)
  })

  test('a failed up reports the step id and redacts the cause', async () => {
    const journal = new FakeJournal()
    const failing: MigrationStep = {
      id: '0001_baseline',
      checksum: CHECKSUM,
      up: async () => {
        throw new Error('CREATE TABLE secret postgres://app:s3cret@db.example/app?password=s3cret')
      },
    }
    try {
      await runMigrations(journal, [failing], [])
      throw new Error('expected failure')
    } catch (err) {
      expect(codeOf(err)).toBe('MIGRATION_FAILED')
      expect((err as BreadError).message).toBe('Migration 0001_baseline failed.')
      expect((err as BreadError).message).not.toContain('CREATE TABLE')
      expect((err as BreadError).message).not.toContain('s3cret')
      const cause = (err as BreadError).cause
      expect(cause).toBeInstanceOf(Error)
      expect((cause as Error).message).not.toContain('s3cret')
      expect((cause as Error).message).not.toContain('app:')
      expect((cause as Error).message).toContain('CREATE TABLE')
    }
    expect(journal.rows).toEqual([])
  })

  test('the check path reports pending ids without applying them', async () => {
    const journal = new FakeJournal()
    const ups: string[] = []
    const status = await readMigrationStatus(journal, [step('0001_baseline', CHECKSUM, ups)], [])
    expect(status).toEqual({ pending: ['0001_baseline'] })
    expect(ups).toEqual([])
    expect(journal.ensureCalls).toBe(0)
  })
})
