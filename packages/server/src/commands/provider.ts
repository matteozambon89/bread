import { BreadError } from '@breadai/core'
import { providerEntries } from '@breadai/provider-catalog'

export interface ProviderListOptions {
  cwd: string
}

export interface ProviderAddOptions {
  cwd: string
  name: string
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

function requireEntry(name: string): (typeof providerEntries)[string] {
  const entry = providerEntries[name]
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

  if (isInstalled(manifest, entry.pkg)) {
    console.log(`[bread] ${entry.pkg} is already installed`)
  } else {
    console.log(`[bread] Installing ${entry.pkg}...`)
    const proc = Bun.spawn(['bun', 'add', entry.pkg], {
      cwd: opts.cwd,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new BreadError(`\`bun add ${entry.pkg}\` failed (exit ${exitCode})`, 'PROVIDER_INSTALL_FAILED', {
        provider: opts.name,
        pkg: entry.pkg,
      })
    }
  }

  if (entry.envVars.length > 0) {
    const missing = missingEnvVars(entry.envVars)
    console.log(`[bread] ${opts.name} reads: ${entry.envVars.join(', ')}`)
    if (missing.length > 0) {
      console.log(`[bread] Not currently set: ${missing.join(', ')}`)
    }
  } else {
    console.log(`[bread] ${opts.name} needs no env vars (zero-config)`)
  }

  console.log(
    `[bread] Set this agent's model to use it: model: { provider: '${opts.name}', model: '<model-id>' }` +
      ' (or via env vars, if the agent reads process.env for them).',
  )
}
