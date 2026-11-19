import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const groups = ['packages', 'extensions', 'stores', 'providers', 'protocols', 'transports', 'graphs']

function hasDeclaration(dir: string): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return false
  }
  for (const name of names) {
    const path = join(dir, name)
    if (name.endsWith('.d.ts')) return true
    try {
      if (statSync(path).isDirectory() && hasDeclaration(path)) return true
    } catch {
      // A dist entry can disappear while this walk runs.
    }
  }
  return false
}

// tsc -b trusts tsconfig.tsbuildinfo after dist/ is removed. The cache stays
// beside the package tsconfig, outside dist/, so a missing .d.ts drops it.
export function dropStaleBuildInfo(root: string): void {
  for (const group of groups) {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) continue
    let names: string[]
    try {
      names = readdirSync(groupDir)
    } catch {
      continue
    }
    for (const name of names) {
      const pkg = join(groupDir, name)
      const packedInfo = join(pkg, 'dist', 'tsconfig.tsbuildinfo')
      if (existsSync(packedInfo)) rmSync(packedInfo)
      const info = join(pkg, 'tsconfig.tsbuildinfo')
      if (!existsSync(info)) continue
      const dist = join(pkg, 'dist')
      if (!existsSync(dist) || !hasDeclaration(dist)) rmSync(info)
    }
  }
}

if (import.meta.main) dropStaleBuildInfo(join(import.meta.dir, '..'))
