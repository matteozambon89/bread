import { describe, expect, test } from 'bun:test'
import { planBump } from './plan.ts'
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
  version: '0.1.2',
  deps: { '@breadai/core': 'workspace:>=0.1.1 <1.0.0' },
})
const server = pkg({
  name: '@breadai/server',
  dir: 'packages/server',
  deps: { '@breadai/core': 'workspace:>=0.1.1 <1.0.0' },
})
const serverOnMajor = pkg({
  name: '@breadai/server',
  dir: 'packages/server',
  deps: { '@breadai/core': 'workspace:>=1.0.0 <2.0.0' },
})

describe('planBump', () => {
  test('bumps only the named affected package', () => {
    const plan = planBump([core, catalog, server], ['@breadai/core'], 'patch')
    expect(plan.bumps.map((bump) => `${bump.name}:${bump.from}:${bump.to}`)).toEqual([
      '@breadai/core:0.1.1:0.1.2',
    ])
  })

  test('does not bump an unaffected package that already has a newer version', () => {
    const plan = planBump([core, catalog], ['@breadai/provider-catalog'], 'patch')
    expect(plan.bumps.map((bump) => bump.name)).toEqual(['@breadai/provider-catalog'])
  })

  test('computes the next catalog patch from its own current version', () => {
    const plan = planBump([core, catalog], ['@breadai/provider-catalog'], 'patch')
    expect(plan.bumps[0]?.to).toBe('0.1.3')
  })

  test('leaves dependents unpublished when a core patch still satisfies their range', () => {
    const plan = planBump([core, server], ['@breadai/core'], 'patch')
    expect(plan.leftBehind).toEqual([])
  })

  test('refuses a core major when server still declares the 0.x range', () => {
    const plan = planBump([core, server], ['@breadai/core'], 'major')
    expect(plan.leftBehind).toEqual([
      {
        dependent: '@breadai/server',
        dependency: '@breadai/core',
        range: '>=0.1.1 <1.0.0',
        version: '1.0.0',
      },
    ])
  })

  test('refuses a core premajor when server still declares the 0.x range', () => {
    const plan = planBump([core, server], ['@breadai/core'], 'premajor', 'alpha')
    expect(plan.leftBehind).toEqual([
      {
        dependent: '@breadai/server',
        dependency: '@breadai/core',
        range: '>=0.1.1 <1.0.0',
        version: '1.0.0-alpha.0',
      },
    ])
  })

  test('leaves dependents unpublished when a core prepatch still satisfies their range', () => {
    const plan = planBump([core, server], ['@breadai/core'], 'prepatch', 'alpha')
    expect(plan.leftBehind).toEqual([])
  })

  test('leaves dependents unpublished when a core preminor still satisfies their range', () => {
    const plan = planBump([core, server], ['@breadai/core'], 'preminor', 'alpha')
    expect(plan.leftBehind).toEqual([])
  })

  test('accepts a core major when server already declares the 1.x range', () => {
    const plan = planBump([core, serverOnMajor], ['@breadai/core', '@breadai/server'], 'major')
    expect(plan.leftBehind).toEqual([])
  })

  test('bumps server too when it is in the affected set alongside a core major', () => {
    const plan = planBump([core, serverOnMajor], ['@breadai/core', '@breadai/server'], 'major')
    expect(plan.bumps.map((bump) => bump.name)).toEqual(['@breadai/core', '@breadai/server'])
  })
})
