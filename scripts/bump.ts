// Lockstep version bump: sets `version` on every publishable package (skips
// private ones). All @breadai/* packages release together under one version —
// workspace:* cross-references need no rewriting (bun resolves them to the
// packaged version at publish time).
//
//   bun scripts/bump.ts 0.2.0
import { join } from 'node:path'
import { readdirSync } from 'node:fs'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: bun scripts/bump.ts <semver>   (e.g. 0.2.0 or 0.2.0-alpha.1)')
  process.exit(1)
}

const roots = ['packages', 'stores', 'providers', 'protocols', 'extensions', 'transports']
let bumped = 0

for (const root of roots) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, 'package.json')
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    const pkg = (await file.json()) as { name: string; version: string; private?: boolean }
    if (pkg.private) continue
    const before = pkg.version
    pkg.version = version
    await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`${pkg.name}: ${before} → ${version}`)
    bumped++
  }
}

console.log(`\n${bumped} package(s) bumped to ${version}.`)
