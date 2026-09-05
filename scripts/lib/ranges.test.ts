import { describe, expect, test } from 'bun:test'
import { compatibleRange, rangeSatisfied, stripWorkspaceProtocol, workspaceCompatibleRange } from './ranges.ts'

describe('compatibleRange', () => {
  test('allows patch and minor of a 0.x version, but not the next major', () => {
    expect(compatibleRange('0.1.1')).toBe('>=0.1.1 <1.0.0')
  })

  test('allows patch and minor of a 1.x version, but not the next major', () => {
    expect(compatibleRange('1.2.3')).toBe('>=1.2.3 <2.0.0')
  })

  test('throws on an invalid version', () => {
    expect(() => compatibleRange('not-a-version')).toThrow('invalid semver: not-a-version')
  })
})

describe('workspaceCompatibleRange', () => {
  test('prefixes the compatible range with the workspace protocol', () => {
    expect(workspaceCompatibleRange('0.1.1')).toBe('workspace:>=0.1.1 <1.0.0')
  })
})

describe('stripWorkspaceProtocol', () => {
  test('removes a workspace: prefix', () => {
    expect(stripWorkspaceProtocol('workspace:>=0.1.1 <1.0.0')).toBe('>=0.1.1 <1.0.0')
  })

  test('leaves a bare range unchanged', () => {
    expect(stripWorkspaceProtocol('>=0.1.1 <1.0.0')).toBe('>=0.1.1 <1.0.0')
  })
})

describe('rangeSatisfied', () => {
  test('treats a patch bump as compatible with a 0.x compatible range', () => {
    expect(rangeSatisfied('0.1.2', '>=0.1.1 <1.0.0')).toBe(true)
  })

  test('treats a minor bump as compatible with a 0.x compatible range', () => {
    expect(rangeSatisfied('0.2.0', '>=0.1.1 <1.0.0')).toBe(true)
  })

  test('treats a major bump as incompatible with a 0.x compatible range', () => {
    expect(rangeSatisfied('1.0.0', '>=0.1.1 <1.0.0')).toBe(false)
  })

  test('treats a premajor bump as incompatible with a 0.x compatible range', () => {
    expect(rangeSatisfied('1.0.0-alpha.0', '>=0.1.1 <1.0.0')).toBe(false)
  })

  test('treats a prepatch bump as compatible with a 0.x compatible range', () => {
    expect(rangeSatisfied('0.1.2-alpha.0', '>=0.1.1 <1.0.0')).toBe(true)
  })

  test('treats a preminor bump as compatible with a 0.x compatible range', () => {
    expect(rangeSatisfied('0.2.0-alpha.0', '>=0.1.1 <1.0.0')).toBe(true)
  })
})
