import { isPublishable, type WorkspacePackage } from './packages.ts'
import { isBreadPackageName, rangeSatisfied, stripWorkspaceProtocol } from './ranges.ts'

export type LeftBehind = {
  dependent: string
  dependency: string
  range: string
  version: string
}

export type RuntimeDep = {
  name: string
  range: string
}

export function runtimeBreadDeps(pkg: WorkspacePackage): RuntimeDep[] {
  const deps = pkg.manifest.dependencies ?? {}
  return Object.entries(deps)
    .filter(([name]) => isBreadPackageName(name))
    .map(([name, spec]) => ({ name, range: stripWorkspaceProtocol(spec) }))
}

export function findLeftBehind(packages: WorkspacePackage[], planned: Map<string, string>): LeftBehind[] {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))
  const errors: LeftBehind[] = []
  for (const pkg of packages) {
    if (!isPublishable(pkg)) continue
    for (const { name, range } of runtimeBreadDeps(pkg)) {
      const dependency = byName.get(name)
      if (!dependency) continue
      const version = planned.get(name) ?? dependency.manifest.version
      if (!rangeSatisfied(version, range)) {
        errors.push({
          dependent: pkg.manifest.name,
          dependency: name,
          range,
          version,
        })
      }
    }
  }
  return errors
}

export function topoPublishOrder(packages: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))
  const names = new Set(byName.keys())
  const remaining = new Map<string, Set<string>>()
  for (const pkg of packages) {
    const deps = runtimeBreadDeps(pkg)
      .map((dep) => dep.name)
      .filter((name) => names.has(name))
    remaining.set(pkg.manifest.name, new Set(deps))
  }

  const ordered: WorkspacePackage[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([name]) => name)
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].sort().join(', ')
      throw new Error(`circular @breadai runtime dependency: ${cycle}`)
    }
    ready.sort()
    for (const name of ready) {
      remaining.delete(name)
      const pkg = byName.get(name)
      if (pkg) ordered.push(pkg)
      for (const deps of remaining.values()) deps.delete(name)
    }
  }
  return ordered
}
