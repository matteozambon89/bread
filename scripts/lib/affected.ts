import { isPublishable, type WorkspacePackage } from './packages.ts'

const PUBLISHABLE_ROOT_FILES = new Set(['package.json', 'README.md', 'tsconfig.json'])

export function isPublishableRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/')
  if (normalized.startsWith('src/')) return true
  return PUBLISHABLE_ROOT_FILES.has(normalized)
}

export function affectedFromChangedFiles(files: string[], packages: WorkspacePackage[]): WorkspacePackage[] {
  const affected: WorkspacePackage[] = []
  for (const pkg of packages) {
    if (!isPublishable(pkg)) continue
    const prefix = `${pkg.dir}/`
    for (const file of files) {
      const normalized = file.replaceAll('\\', '/')
      if (normalized !== pkg.dir && !normalized.startsWith(prefix)) continue
      const relative = normalized === pkg.dir ? '' : normalized.slice(prefix.length)
      if (isPublishableRelativePath(relative)) {
        affected.push(pkg)
        break
      }
    }
  }
  return affected
}
