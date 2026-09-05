// Affected-only version bump: bump every publishable package whose
// publishable files changed since the last release tag, write nothing
// if a planned version would leave a dependent's range unsatisfied.
//
//   bun scripts/bump.ts --bump patch
//   bun scripts/bump.ts --bump prerelease --preid alpha
//   bun scripts/bump.ts --bump minor --dry-run --plan-out bump-plan.json
import { affectedFromChangedFiles } from './lib/affected.ts'
import { loadWorkspacePackages, writeManifest } from './lib/packages.ts'
import { planBump, type BumpPlan } from './lib/plan.ts'
import type { ReleaseType } from 'semver'

const PRE_TYPES = new Set(['premajor', 'preminor', 'prepatch', 'prerelease'])
const BUMP_TYPES = new Set([
  'major',
  'minor',
  'patch',
  'premajor',
  'preminor',
  'prepatch',
  'prerelease',
])

type Args = {
  bumpType: ReleaseType
  preid?: string
  dryRun: boolean
  since?: string
  planOut?: string
}

function usage(): never {
  console.error(
    'usage: bun scripts/bump.ts --bump <major|minor|patch|premajor|preminor|prepatch|prerelease> [--preid <alpha|beta>] [--dry-run] [--since <tag>] [--plan-out <path>]',
  )
  process.exit(1)
}

function parseArgs(argv: string[]): Args {
  let bumpType: string | undefined
  let preid: string | undefined
  let dryRun = false
  let since: string | undefined
  let planOut: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--bump') {
      bumpType = argv[++i]
      continue
    }
    if (arg === '--preid') {
      preid = argv[++i]
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--since') {
      since = argv[++i]
      continue
    }
    if (arg === '--plan-out') {
      planOut = argv[++i]
      continue
    }
    usage()
  }
  if (!bumpType || !BUMP_TYPES.has(bumpType)) usage()
  if (preid && !PRE_TYPES.has(bumpType)) {
    console.error(`bump: --preid only applies to a pre* bump type, not "${bumpType}"`)
    process.exit(1)
  }
  if (!preid && PRE_TYPES.has(bumpType)) {
    console.error(`bump: "${bumpType}" requires --preid <alpha|beta>`)
    process.exit(1)
  }
  return { bumpType: bumpType as ReleaseType, preid, dryRun, since, planOut }
}

async function gitOutput(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function lastReleaseTag(): Promise<string> {
  const result = await gitOutput(['describe', '--tags', '--match', 'v*', '--abbrev=0'])
  if (!result.ok || !result.stdout) {
    console.error('bump: no v* release tag found (git describe --match v*)')
    if (result.stderr) console.error(result.stderr)
    process.exit(1)
  }
  return result.stdout
}

async function changedFilesSince(tag: string): Promise<string[]> {
  const result = await gitOutput(['diff', '--name-only', `${tag}...HEAD`])
  if (!result.ok) {
    console.error(`bump: git diff against ${tag} failed`)
    if (result.stderr) console.error(result.stderr)
    process.exit(1)
  }
  return result.stdout === '' ? [] : result.stdout.split('\n')
}

function printPlan(since: string, plan: BumpPlan): void {
  console.log(`since: ${since}`)
  if (plan.bumps.length === 0) {
    console.log('affected: (none)')
    return
  }
  console.log('affected:')
  for (const bump of plan.bumps) {
    console.log(`  ${bump.name}: ${bump.from} → ${bump.to}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const since = args.since ?? (await lastReleaseTag())
const packages = await loadWorkspacePackages()
const changed = await changedFilesSince(since)
const affected = affectedFromChangedFiles(changed, packages)
const plan = planBump(
  packages,
  affected.map((pkg) => pkg.manifest.name),
  args.bumpType,
  args.preid,
)

printPlan(since, plan)

if (args.planOut) {
  await Bun.write(
    args.planOut,
    `${JSON.stringify(
      {
        since,
        bumps: plan.bumps.map(({ name, dir, from, to }) => ({ name, dir, from, to })),
        leftBehind: plan.leftBehind,
      },
      null,
      2,
    )}\n`,
  )
}

if (plan.bumps.length === 0) {
  console.error(`\nbump: nothing to release — no publishable package changed since ${since}`)
  process.exit(1)
}

if (plan.leftBehind.length > 0) {
  console.error('\nbump: refusing to bump; these dependency ranges would not satisfy the planned versions:')
  for (const item of plan.leftBehind) {
    console.error(`  ${item.dependent} depends on ${item.dependency}@${item.version} with range "${item.range}"`)
  }
  console.error('Update the dependent package.json (and any code) in a commit, then re-run. No versions were written.')
  process.exit(1)
}

if (args.dryRun) {
  console.log('\ndry run — no package.json files written.')
  process.exit(0)
}

const byPath = new Map(packages.map((pkg) => [pkg.manifestPath, pkg]))
for (const bump of plan.bumps) {
  const pkg = byPath.get(bump.manifestPath)
  if (!pkg) continue
  pkg.manifest.version = bump.to
  await writeManifest(pkg)
}

console.log(`\n${plan.bumps.length} package(s) bumped.`)
