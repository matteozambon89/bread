import { join } from 'node:path'
import { readdirSync } from 'node:fs'

export const PACKAGE_ROOTS = ['packages', 'stores', 'providers', 'protocols', 'extensions', 'transports'] as const

export type Manifest = {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export type WorkspacePackage = {
  dir: string
  manifestPath: string
  manifest: Manifest
}

export async function loadWorkspacePackages(root = process.cwd()): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = []
  for (const group of PACKAGE_ROOTS) {
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = readdirSync(join(root, group), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = `${group}/${entry.name}`
      const manifestPath = join(root, dir, 'package.json')
      const file = Bun.file(manifestPath)
      if (!(await file.exists())) continue
      const manifest = (await file.json()) as Manifest
      packages.push({ dir, manifestPath, manifest })
    }
  }
  return packages
}

export function isPublishable(pkg: WorkspacePackage): boolean {
  return pkg.manifest.private !== true
}

export async function writeManifest(pkg: WorkspacePackage): Promise<void> {
  await Bun.write(pkg.manifestPath, `${JSON.stringify(pkg.manifest, null, 2)}\n`)
}
