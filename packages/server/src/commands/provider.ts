import { BreadError } from '@breadai/core'
import { providerEntries } from '@breadai/provider-llm'
import { spawnCommand } from './spawn.js'

export interface ProviderListOptions {
  cwd: string
}

export interface ProviderAddOptions {
  cwd: string
  name: string
  /** Collect status and installer output instead of writing to the terminal. */
  log?: (line: string) => void
}

interface PackageManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function readManifest(cwd: string): Promise<PackageManifest> {
  const file = Bun.file(`${cwd}/package.json`)
  if (!(await file.exists())) {
    throw new BreadError(`No package.json found at ${cwd}`, 'PACKAGE_JSON_NOT_FOUND', { cwd })
  }
  return (await file.json()) as PackageManifest
}

function isInstalled(manifest: PackageManifest, pkg: string): boolean {
  return Boolean(manifest.dependencies?.[pkg] ?? manifest.devDependencies?.[pkg])
}

function missingEnvVars(envVars: string[]): string[] {
  return envVars.filter((v) => !process.env[v])
}

function requireEntry(name: string): NonNullable<(typeof providerEntries)[string]> {
  // Inherited names have no pkg. Throw before `bun add` can spawn undefined.
  const entry = Object.hasOwn(providerEntries, name) ? providerEntries[name] : undefined
  if (!entry) {
    const available = Object.keys(providerEntries).sort().join(', ')
    throw new BreadError(`Unknown provider "${name}". Available: ${available}`, 'UNKNOWN_PROVIDER', {
      name,
    })
  }
  return entry
}

export async function runProviderList(opts: ProviderListOptions): Promise<void> {
  const manifest = await readManifest(opts.cwd)

  const nameWidth = Math.max(...Object.keys(providerEntries).map((name) => name.length))
  const pkgWidth = Math.max(...Object.values(providerEntries).map((entry) => entry.pkg.length))

  console.log('\nCatalog providers:\n')
  for (const [name, entry] of Object.entries(providerEntries).sort(([a], [b]) => a.localeCompare(b))) {
    const installed = isInstalled(manifest, entry.pkg) ? '✓' : '–'
    const missing = missingEnvVars(entry.envVars)
    const envStr =
      entry.envVars.length === 0
        ? 'no env vars required'
        : missing.length === 0
          ? `${entry.envVars.join(', ')} (set)`
          : `${entry.envVars.join(', ')} (missing: ${missing.join(', ')})`
    console.log(`  ${installed}  ${name.padEnd(nameWidth)} ${entry.pkg.padEnd(pkgWidth)} ${envStr}`)
  }
}

export async function runProviderAdd(opts: ProviderAddOptions): Promise<void> {
  const entry = requireEntry(opts.name)
  const manifest = await readManifest(opts.cwd)
  const log = (line: string): void => {
    if (opts.log) opts.log(line)
    else console.log(line)
  }
  const capture = opts.log !== undefined

  if (isInstalled(manifest, entry.pkg)) {
    log(`[bread] ${entry.pkg} is already installed`)
  } else {
    log(`[bread] Installing ${entry.pkg}...`)
    const { exitCode, output } = await spawnCommand(['bun', 'add', entry.pkg], opts.cwd, capture)
    if (output.trim() !== '') log(output.trimEnd())
    if (exitCode !== 0) {
      throw new BreadError(`\`bun add ${entry.pkg}\` failed (exit ${exitCode})`, 'PROVIDER_INSTALL_FAILED', {
        provider: opts.name,
        pkg: entry.pkg,
      })
    }
  }

  if (entry.envVars.length > 0) {
    const missing = missingEnvVars(entry.envVars)
    log(`[bread] ${opts.name} reads: ${entry.envVars.join(', ')}`)
    if (missing.length > 0) {
      log(`[bread] Not currently set: ${missing.join(', ')}`)
    }
  } else {
    log(`[bread] ${opts.name} needs no env vars (zero-config)`)
  }

  log(
    `[bread] Set this agent's model to use it: model: { provider: '${opts.name}', model: '<model-id>' }` +
      ' (or via env vars, if the agent reads process.env for them).',
  )
}
