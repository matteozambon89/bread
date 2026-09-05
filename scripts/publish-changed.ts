// Print publishable package dirs whose local version is not on npm,
// in runtime-dependency order (dependency before dependent).
import { topoPublishOrder } from './lib/graph.ts'
import { isPublishable, loadWorkspacePackages } from './lib/packages.ts'

async function isOnNpm(name: string, version: string): Promise<boolean> {
  const proc = Bun.spawn(['npm', 'view', `${name}@${version}`, 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}

const packages = (await loadWorkspacePackages()).filter(isPublishable)
const ordered = topoPublishOrder(packages)
const toPublish: string[] = []

for (const pkg of ordered) {
  const { name, version } = pkg.manifest
  if (await isOnNpm(name, version)) {
    console.error(`→ skip ${pkg.dir} (${name}@${version} already on npm)`)
    continue
  }
  console.error(`→ publish ${pkg.dir} (${name}@${version})`)
  toPublish.push(pkg.dir)
}

for (const dir of toPublish) console.log(dir)

if (toPublish.length === 0) {
  console.error('publish-changed: every public package version is already on npm')
}
