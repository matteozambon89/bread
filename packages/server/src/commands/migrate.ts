import { BreadError, isMigrationStepId, type BreadConfig } from '@breadai/core'
import { loadConfig } from '../loader.js'

export function applyNoMigrate(config: BreadConfig, noMigrate: boolean | undefined): void {
  if (noMigrate !== true) return
  config.server = { ...config.server, migrate: false }
}

export interface MigrateOptions {
  cwd: string
}

function printIds(label: string, ids: readonly string[]): void {
  for (const id of ids) {
    if (typeof id !== 'string' || !isMigrationStepId(id)) {
      throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
    }
    console.log(`${label} ${id}`)
  }
}

// Applies the journal directly. Does not listen, mount a transport, or init
// plugins or remote agents, and ignores server.migrate.
export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const { store } = await loadConfig(opts.cwd)
  if (!store) {
    throw new BreadError(
      "No store configured. Set `store` in bread.config.ts — e.g. `store({ path: './bread.db' })` " +
        'from `@breadai/store-sqlite`, or `store()` from `@breadai/store-postgres` (reads DATABASE_URL).',
      'STORE_NOT_CONFIGURED',
    )
  }
  try {
    if (!store.migrate) {
      throw new BreadError('Migrations are pending.', 'MIGRATIONS_PENDING', { reason: 'no_migrate' })
    }
    const report = await store.migrate()
    if (!report || !Array.isArray(report.applied) || !Array.isArray(report.skipped)) {
      throw new BreadError('Migration step id is invalid.', 'MIGRATION_INVALID', {})
    }
    printIds('applied', report.applied)
    printIds('skipped', report.skipped)
  } finally {
    await store.close?.()
  }
}
