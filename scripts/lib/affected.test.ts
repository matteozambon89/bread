import { describe, expect, test } from 'bun:test'
import { affectedFromChangedFiles, isPublishableRelativePath } from './affected.ts'
import type { WorkspacePackage } from './packages.ts'

function pkg(opts: { name: string; dir: string; private?: boolean }): WorkspacePackage {
  return {
    dir: opts.dir,
    manifestPath: `${opts.dir}/package.json`,
    manifest: { name: opts.name, version: '0.1.1', private: opts.private },
  }
}

const catalog = pkg({ name: '@breadai/provider-catalog', dir: 'providers/catalog' })
const core = pkg({ name: '@breadai/core', dir: 'packages/core' })
const testUtils = pkg({ name: '@breadai/test-utils', dir: 'packages/test-utils', private: true })

describe('isPublishableRelativePath', () => {
  test('counts a file under src/ as publishable', () => {
    expect(isPublishableRelativePath('src/index.ts')).toBe(true)
  })

  test('counts package.json as publishable', () => {
    expect(isPublishableRelativePath('package.json')).toBe(true)
  })

  test('does not count a test file as publishable', () => {
    expect(isPublishableRelativePath('test/index.test.ts')).toBe(false)
  })
})

describe('affectedFromChangedFiles', () => {
  test('marks only the package whose src changed', () => {
    const affected = affectedFromChangedFiles(['providers/catalog/src/index.ts'], [catalog, core])
    expect(affected.map((item) => item.manifest.name)).toEqual(['@breadai/provider-catalog'])
  })

  test('returns an empty list for tests-only changes', () => {
    const affected = affectedFromChangedFiles(['packages/core/test/ids.test.ts'], [catalog, core])
    expect(affected).toEqual([])
  })

  test('returns an empty list for a package docs path that is not publishable', () => {
    const affected = affectedFromChangedFiles(['packages/core/docs/foo.md'], [catalog, core])
    expect(affected).toEqual([])
  })

  test('marks a package whose README.md changed', () => {
    const affected = affectedFromChangedFiles(['packages/core/README.md'], [catalog, core])
    expect(affected.map((item) => item.manifest.name)).toEqual(['@breadai/core'])
  })

  test('skips a private package even when its src changed', () => {
    const affected = affectedFromChangedFiles(['packages/test-utils/src/index.ts'], [testUtils, core])
    expect(affected).toEqual([])
  })
})
