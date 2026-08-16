// Lockstep version bump: sets `version` on every publishable package (skips
// private ones). All @breadai/* packages release together under one version —
// workspace:* cross-references need no rewriting (bun resolves them to the
// packaged version at publish time).
//
//   bun scripts/bump.ts 0.2.0                          # exact version
//   bun scripts/bump.ts --bump patch                    # computed from the current one
//   bun scripts/bump.ts --bump prerelease --preid alpha # computed, with a pre-release id
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import semver from 'semver'

const roots = ['packages', 'stores', 'providers', 'protocols', 'extensions', 'transports']
const preTypes = new Set(['premajor', 'preminor', 'prepatch', 'prerelease'])

type Pkg = { name: string; version: string; private?: boolean }

function packagePaths(): string[] {
  const paths: string[] = []
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(root, entry.name, 'package.json'))
    }
  }
  return paths
}

// The current lockstep version, read from the first non-private package
// found — every publishable package already shares one, so any of them is
// ground truth.
async function currentVersion(): Promise<string> {
  for (const path of packagePaths()) {
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    const pkg = (await file.json()) as Pkg
    if (!pkg.private) return pkg.version
  }
  console.error('bump: no non-private package found to read the current version from')
  process.exit(1)
}

function usage(): never {
  console.error(
    'usage: bun scripts/bump.ts <semver>   (e.g. 0.2.0 or 0.2.0-alpha.1)\n' +
      '   or: bun scripts/bump.ts --bump <major|minor|patch|premajor|preminor|prepatch|prerelease> [--preid <alpha|beta>]',
  )
  process.exit(1)
}

async function resolveVersion(): Promise<string> {
  const [first, ...rest] = process.argv.slice(2)
  if (first !== '--bump') {
    if (!first || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(first)) usage()
    return first
  }

  const bumpType = rest[0]
  if (!bumpType || !['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'].includes(bumpType))
    usage()
  const preidIndex = rest.indexOf('--preid')
  const preid = preidIndex === -1 ? undefined : rest[preidIndex + 1]
  if (preid && !preTypes.has(bumpType)) {
    console.error(`bump: --preid only applies to a pre* bump type, not "${bumpType}"`)
    process.exit(1)
  }
  if (!preid && preTypes.has(bumpType)) {
    console.error(`bump: "${bumpType}" requires --preid <alpha|beta>`)
    process.exit(1)
  }

  const current = await currentVersion()
  const next = semver.inc(current, bumpType as semver.ReleaseType, preid)
  if (!next) {
    console.error(`bump: could not compute a "${bumpType}" bump from current version "${current}"`)
    process.exit(1)
  }
  console.log(`computed: ${current} → ${next} (${bumpType}${preid ? `, preid ${preid}` : ''})`)
  return next
}

const version = await resolveVersion()
let bumped = 0

for (const path of packagePaths()) {
  const file = Bun.file(path)
  if (!(await file.exists())) continue
  const pkg = (await file.json()) as Pkg
  if (pkg.private) continue
  const before = pkg.version
  pkg.version = version
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name}: ${before} → ${version}`)
  bumped++
}

console.log(`\n${bumped} package(s) bumped to ${version}.`)
