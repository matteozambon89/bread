import semver from 'semver'
import { findLeftBehind, type LeftBehind } from './graph.ts'
import type { WorkspacePackage } from './packages.ts'

export type Bump = {
  name: string
  dir: string
  manifestPath: string
  from: string
  to: string
}

export type BumpPlan = {
  bumps: Bump[]
  leftBehind: LeftBehind[]
}

export function planBump(
  packages: WorkspacePackage[],
  affectedNames: Iterable<string>,
  bumpType: semver.ReleaseType,
  preid?: string,
): BumpPlan {
  const affected = new Set(affectedNames)
  const planned = new Map<string, string>()
  const bumps: Bump[] = []

  for (const pkg of packages) {
    if (!affected.has(pkg.manifest.name)) continue
    const next = semver.inc(pkg.manifest.version, bumpType, preid)
    if (!next) {
      throw new Error(`could not compute a "${bumpType}" bump from ${pkg.manifest.name}@${pkg.manifest.version}`)
    }
    planned.set(pkg.manifest.name, next)
    bumps.push({
      name: pkg.manifest.name,
      dir: pkg.dir,
      manifestPath: pkg.manifestPath,
      from: pkg.manifest.version,
      to: next,
    })
  }

  return { bumps, leftBehind: findLeftBehind(packages, planned) }
}
