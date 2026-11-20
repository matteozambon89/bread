import { createHash } from 'node:crypto'
import { BreadError } from '../types.js'
import { redactConnectionSecrets, redactError } from './redact.js'

const STEP_ID = /^[0-9]{4}_[a-z][a-z0-9_]*$/

export function isMigrationStepId(id: string): boolean {
  return STEP_ID.test(id)
}

export function migrationChecksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface MigrationStep {
  id: string
  checksum: string
  up: () => Promise<void>
}

export interface AppliedMigration {
  id: string
  checksum: string
}

export interface MigrationLock {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface MigrationJournal {
  applied(): Promise<AppliedMigration[]>
  ensure(): Promise<void>
  record(id: string, checksum: string): Promise<boolean>
  lock?(): Promise<MigrationLock>
}

export interface MigrationReport {
  applied: string[]
  skipped: string[]
}

export interface MigrationStatus {
  pending: string[]
}

function fail(err: unknown, fallback: string, code: string, context?: Record<string, unknown>): never {
  if (err instanceof BreadError) {
    throw new BreadError(redactConnectionSecrets(err.message), err.code, err.context, redactError(err.cause))
  }
  throw new BreadError(fallback, code, context, redactError(err))
}

function stepContext(id: string): Record<string, unknown> | undefined {
  return isMigrationStepId(id) ? { step: id } : undefined
}

function validateList(steps: readonly MigrationStep[], knownIds: readonly string[]): void {
  const seen = new Set<string>()
  let previous = ''
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || !isMigrationStepId(step.id)) {
      throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
    }
    if (seen.has(step.id)) {
      throw new BreadError('Migration step ids are duplicated.', 'MIGRATION_INVALID', { step: step.id })
    }
    if (previous !== '' && step.id <= previous) {
      throw new BreadError('Migration steps are not in lexical order.', 'MIGRATION_INVALID', { step: step.id })
    }
    if (typeof step.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(step.checksum)) {
      throw new BreadError('Migration checksum is invalid.', 'MIGRATION_INVALID', { step: step.id })
    }
    if (typeof step.up !== 'function') {
      throw new BreadError('Migration step is invalid.', 'MIGRATION_INVALID', { step: step.id })
    }
    seen.add(step.id)
    previous = step.id
  }
  const known = new Set<string>()
  for (const id of knownIds) {
    if (typeof id !== 'string' || !isMigrationStepId(id) || known.has(id)) {
      throw new BreadError('Migration known id is invalid.', 'MIGRATION_INVALID', {})
    }
    known.add(id)
  }
}

interface Plan {
  pending: MigrationStep[]
  skipped: string[]
}

function planMigrations(
  rows: readonly AppliedMigration[],
  steps: readonly MigrationStep[],
  knownIds: readonly string[],
): Plan {
  const known = new Set(knownIds)
  const applied = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || typeof row.checksum !== 'string' || applied.has(row.id)) {
      throw new BreadError('Migration history is ahead.', 'MIGRATION_AHEAD', {})
    }
    applied.add(row.id)
    const step = steps.find((candidate) => candidate.id === row.id)
    if (step) {
      if (step.checksum !== row.checksum) {
        throw new BreadError(`Migration ${step.id} checksum changed.`, 'MIGRATION_CHANGED', { step: step.id })
      }
      continue
    }
    if (!known.has(row.id)) {
      const context = stepContext(row.id)
      throw new BreadError(
        context ? `Migration ${row.id} is not in the current steps.` : 'Migration history is ahead.',
        'MIGRATION_AHEAD',
        context,
      )
    }
  }

  const skipped: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    if (!applied.has(step.id)) {
      for (const later of steps.slice(i + 1)) {
        if (applied.has(later.id)) {
          throw new BreadError(`Migration ${later.id} is ahead of the current steps.`, 'MIGRATION_AHEAD', {
            step: later.id,
          })
        }
      }
      return { pending: steps.slice(i), skipped }
    }
    skipped.push(step.id)
  }
  return { pending: [], skipped }
}

async function withLock<T>(journal: MigrationJournal, commit: boolean, fn: () => Promise<T>): Promise<T> {
  if (!journal.lock) return fn()
  let locked: MigrationLock
  try {
    locked = await journal.lock()
  } catch (err) {
    fail(err, 'Could not acquire the migration lock.', 'MIGRATION_LOCK')
  }
  try {
    const result = await fn()
    if (commit) await locked.commit()
    else await locked.rollback()
    return result
  } catch (err) {
    try {
      await locked.rollback()
    } catch {
      // The original failure is the one callers need.
    }
    throw err
  }
}

export async function runMigrations(
  journal: MigrationJournal,
  steps: readonly MigrationStep[],
  knownIds: readonly string[] = [],
): Promise<MigrationReport> {
  validateList(steps, knownIds)
  return withLock(journal, true, async () => {
    try {
      await journal.ensure()
    } catch (err) {
      fail(err, 'Migration journal could not be created.', 'MIGRATION_FAILED')
    }
    let rows: AppliedMigration[]
    try {
      rows = await journal.applied()
    } catch (err) {
      fail(err, 'Migration journal could not be read.', 'MIGRATION_FAILED')
    }
    const plan = planMigrations(rows, steps, knownIds)
    const applied: string[] = []
    for (const step of plan.pending) {
      try {
        await step.up()
      } catch (err) {
        throw new BreadError(`Migration ${step.id} failed.`, 'MIGRATION_FAILED', { step: step.id }, redactError(err))
      }
      let recorded = false
      try {
        recorded = await journal.record(step.id, step.checksum)
      } catch (err) {
        fail(err, `Migration ${step.id} failed.`, 'MIGRATION_FAILED', { step: step.id })
      }
      if (!recorded) {
        throw new BreadError(`Migration ${step.id} was recorded by another runner.`, 'MIGRATION_CONFLICT', {
          step: step.id,
        })
      }
      applied.push(step.id)
    }
    return { applied, skipped: plan.skipped }
  })
}

export async function readMigrationStatus(
  journal: MigrationJournal,
  steps: readonly MigrationStep[],
  knownIds: readonly string[] = [],
): Promise<MigrationStatus> {
  validateList(steps, knownIds)
  return withLock(journal, false, async () => {
    let rows: AppliedMigration[]
    try {
      rows = await journal.applied()
    } catch (err) {
      if (err instanceof BreadError && err.code === 'MIGRATION_JOURNAL_MISSING') {
        throw new BreadError('Migration journal is missing.', 'MIGRATIONS_PENDING', { reason: 'missing_journal' }, redactError(err.cause))
      }
      fail(err, 'Migration journal could not be read.', 'MIGRATION_FAILED')
    }
    const plan = planMigrations(rows, steps, knownIds)
    return { pending: plan.pending.map((step) => step.id) }
  })
}

export async function assertMigrationsCurrent(store: {
  migrations?: () => Promise<MigrationStatus>
}): Promise<void> {
  if (!store.migrations) {
    throw new BreadError('Migrations are pending.', 'MIGRATIONS_PENDING', { reason: 'no_check' })
  }
  const status = await store.migrations()
  if (!status || !Array.isArray(status.pending)) {
    throw new BreadError('Migrations are pending.', 'MIGRATIONS_PENDING', { reason: 'no_check' })
  }
  const pending = status.pending.filter((id) => typeof id === 'string' && isMigrationStepId(id))
  if (status.pending.length > 0) {
    throw new BreadError('Migrations are pending.', 'MIGRATIONS_PENDING', { pending })
  }
}
