import semver from 'semver'

export function compatibleRange(version: string): string {
  const parsed = semver.parse(version)
  if (!parsed) throw new Error(`invalid semver: ${version}`)
  return `>=${parsed.major}.${parsed.minor}.${parsed.patch} <${parsed.major + 1}.0.0`
}

export function workspaceCompatibleRange(version: string): string {
  return `workspace:${compatibleRange(version)}`
}

export function stripWorkspaceProtocol(spec: string): string {
  return spec.startsWith('workspace:') ? spec.slice('workspace:'.length) : spec
}

export function isBreadPackageName(name: string): boolean {
  return name.startsWith('@breadai/')
}

export function rangeSatisfied(version: string, range: string): boolean {
  const parsed = semver.parse(version)
  if (!parsed) return false
  // Strip prerelease so 1.0.0-alpha.0 is gated like 1.0.0, not treated as <1.0.0.
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return semver.satisfies(core, range)
}
