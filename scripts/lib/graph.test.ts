import { describe, expect, test } from 'bun:test'
import { findLeftBehind, topoPublishOrder } from './graph.ts'
import type { WorkspacePackage } from './packages.ts'

function pkg(opts: {
  name: string
  dir: string
  version?: string
  deps?: Record<string, string>
}): WorkspacePackage {
  return {
    dir: opts.dir,
    manifestPath: `${opts.dir}/package.json`,
    manifest: {
      name: opts.name,
      version: opts.version ?? '0.1.1',
      dependencies: opts.deps,
    },
  }
}

const core = pkg({ name: '@breadai/core', dir: 'packages/core' })
const catalog = pkg({
  name: '@breadai/provider-catalog',
  dir: 'providers/catalog',
  deps: { '@breadai/core': 'workspace:>=0.1.1 <1.0.0' },
})
const server = pkg({
  name: '@breadai/server',
  dir: 'packages/server',
  deps: {
    '@breadai/core': 'workspace:>=0.1.1 <1.0.0',
    '@breadai/provider-catalog': 'workspace:>=0.1.1 <1.0.0',
  },
})
const cli = pkg({
  name: '@breadai/cli',
  dir: 'packages/cli',
  deps: { '@breadai/server': 'workspace:>=0.1.1 <1.0.0' },
})

describe('findLeftBehind', () => {
  test('returns nothing when a patch of core still satisfies dependents', () => {
    const planned = new Map([['@breadai/core', '0.1.2']])
    expect(findLeftBehind([core, catalog, server, cli], planned)).toEqual([])
  })

  test('returns nothing when a minor of core still satisfies dependents', () => {
    const planned = new Map([['@breadai/core', '0.2.0']])
    expect(findLeftBehind([core, catalog, server, cli], planned)).toEqual([])
  })

  test('names each dependent whose range does not satisfy a major of core', () => {
    const planned = new Map([['@breadai/core', '1.0.0']])
    expect(findLeftBehind([core, catalog, server], planned)).toEqual([
      {
        dependent: '@breadai/provider-catalog',
        dependency: '@breadai/core',
        range: '>=0.1.1 <1.0.0',
        version: '1.0.0',
      },
      {
        dependent: '@breadai/server',
        dependency: '@breadai/core',
        range: '>=0.1.1 <1.0.0',
        version: '1.0.0',
      },
    ])
  })
})

describe('topoPublishOrder', () => {
  test('orders core before server before cli', () => {
    const ordered = topoPublishOrder([cli, server, core])
    expect(ordered.map((item) => item.manifest.name)).toEqual([
      '@breadai/core',
      '@breadai/server',
      '@breadai/cli',
    ])
  })
})
