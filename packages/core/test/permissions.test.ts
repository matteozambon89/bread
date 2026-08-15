import { describe, expect, test } from 'bun:test'
import {
  assertName,
  leafName,
  matchesSelector,
  parseSelector,
  permId,
  resolvePermissions,
  type ToolOrigin,
} from '../src/permissions.js'
import { BreadError } from '../src/types.js'

describe('assertName', () => {
  test('accepts snake_case names starting with a letter', () => {
    expect(() => assertName('tool', 'web_search')).not.toThrow()
    expect(() => assertName('tool', 'a')).not.toThrow()
    expect(() => assertName('tool', 'a1_b2')).not.toThrow()
  })

  test.each([
    ['1leading_digit'],
    ['Has_Upper'],
    ['has-dash'],
    ['has space'],
    ['has:colon'],
    ['has/slash'],
    [''],
  ])('rejects "%s"', (value) => {
    expect(() => assertName('tool', value)).toThrow(BreadError)
  })

  test('throws INVALID_NAME with kind/value context', () => {
    try {
      assertName('skill', 'Bad-Name')
      throw new Error('expected assertName to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      const e = err as BreadError
      expect(e.code).toBe('INVALID_NAME')
      expect(e.context).toEqual({ kind: 'skill', value: 'Bad-Name' })
    }
  })
})

describe('leafName / permId — isomorphism', () => {
  test('tool scope', () => {
    const origin: ToolOrigin = { scope: 'tool', name: 'web_search' }
    expect(leafName(origin)).toBe('tool_web_search')
    expect(permId(origin)).toBe('tool:web_search')
  })

  test('task scope', () => {
    const origin: ToolOrigin = { scope: 'task', name: 'doc_extract' }
    expect(leafName(origin)).toBe('task_doc_extract')
    expect(permId(origin)).toBe('task:doc_extract')
  })

  test('core scope', () => {
    const origin: ToolOrigin = { scope: 'core', name: 'doc_ingest' }
    expect(leafName(origin)).toBe('core_doc_ingest')
    expect(permId(origin)).toBe('core:doc_ingest')
  })

  test('human scope', () => {
    const origin: ToolOrigin = { scope: 'human', name: 'approve' }
    expect(leafName(origin)).toBe('human_approve')
    expect(permId(origin)).toBe('human:approve')
  })

  test('skill scope (sub-scoped)', () => {
    const origin: ToolOrigin = { scope: 'skill', sub: 'deep_research', name: 'cite' }
    expect(leafName(origin)).toBe('skill_deep_research_cite')
    expect(permId(origin)).toBe('skill:deep_research/cite')
  })

  test('plugin scope (sub-scoped)', () => {
    const origin: ToolOrigin = { scope: 'plugin', sub: 'metrics', name: 'flush' }
    expect(leafName(origin)).toBe('plugin_metrics_flush')
    expect(permId(origin)).toBe('plugin:metrics/flush')
  })

  test('sub-scope without "sub" throws', () => {
    const origin = { scope: 'plugin', name: 'read' } as ToolOrigin
    expect(() => leafName(origin)).toThrow(BreadError)
    expect(() => permId(origin)).toThrow(BreadError)
  })
})

describe('parseSelector — valid', () => {
  test('no-sub scope, concrete name', () => {
    expect(parseSelector('tool:web_search')).toEqual({ scope: 'tool', name: 'web_search' })
  })

  test('no-sub scope, full wildcard', () => {
    expect(parseSelector('tool:*')).toEqual({ scope: 'tool', sub: undefined, name: '*' })
  })

  test('sub-scope, concrete sub/name', () => {
    expect(parseSelector('plugin:filesystem/read')).toEqual({ scope: 'plugin', sub: 'filesystem', name: 'read' })
  })

  test('sub-scope, full wildcard', () => {
    expect(parseSelector('plugin:*')).toEqual({ scope: 'plugin', sub: '*', name: '*' })
  })

  test('sub-scope, wildcard name within a concrete sub', () => {
    expect(parseSelector('skill:deep_research/*')).toEqual({
      scope: 'skill',
      sub: 'deep_research',
      name: '*',
    })
  })

  test('sub-scope, wildcard sub with a concrete name', () => {
    expect(parseSelector('plugin:*/flush')).toEqual({ scope: 'plugin', sub: '*', name: 'flush' })
  })
})

describe('parseSelector — partial-segment globs', () => {
  test('a partial glob in a no-sub name', () => {
    expect(parseSelector('tool:read_*')).toEqual({ scope: 'tool', name: 'read_*' })
  })

  test('a partial glob in both sub and name', () => {
    expect(parseSelector('plugin:mcp_*/read_*')).toEqual({
      scope: 'plugin',
      sub: 'mcp_*',
      name: 'read_*',
    })
  })

  test('a wildcard in the middle of a segment', () => {
    expect(parseSelector('tool:get_*_by_id')).toEqual({ scope: 'tool', name: 'get_*_by_id' })
  })

  test('a leading wildcard', () => {
    expect(parseSelector('tool:*_v2')).toEqual({ scope: 'tool', name: '*_v2' })
  })
})

describe('parseSelector — invalid', () => {
  test.each([
    ['*', 'bare wildcard with no scope'],
    ['mpc:*', 'unknown/typo scope'],
    ['human:approve', 'human scope forbidden in selectors'],
    ['human:*', 'human wildcard forbidden too'],
    ['tool:', 'missing body'],
    ['tool:has-dash', 'bad charset in name'],
    ['tool:filesystem/read', 'no-sub scope given a sub-id'],
    ['plugin:filesystem', 'sub-scope missing its sub-id'],
    ['plugin:a/b/c', 'more than one slash'],
    ['plugin:Bad/read', 'bad charset in sub'],
    ['plugin:filesystem/Bad', 'bad charset in name'],
  ])('rejects "%s" (%s)', (selector) => {
    expect(() => parseSelector(selector)).toThrow(BreadError)
  })

  test('throws INVALID_PERMISSION with the selector in context', () => {
    try {
      parseSelector('mpc:*')
      throw new Error('expected parseSelector to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      const e = err as BreadError
      expect(e.code).toBe('INVALID_PERMISSION')
      expect(e.context).toEqual({ selector: 'mpc:*' })
    }
  })
})

describe('matchesSelector', () => {
  const pluginRead: ToolOrigin = { scope: 'plugin', sub: 'filesystem', name: 'read' }
  const pluginWrite: ToolOrigin = { scope: 'plugin', sub: 'filesystem', name: 'write' }
  const pluginOtherServer: ToolOrigin = { scope: 'plugin', sub: 'github', name: 'read' }
  const toolSearch: ToolOrigin = { scope: 'tool', name: 'web_search' }

  test('exact match', () => {
    expect(matchesSelector('plugin:filesystem/read', pluginRead)).toBe(true)
    expect(matchesSelector('plugin:filesystem/read', pluginWrite)).toBe(false)
  })

  test('scope-wide wildcard matches any sub/name in that scope', () => {
    expect(matchesSelector('plugin:*', pluginRead)).toBe(true)
    expect(matchesSelector('plugin:*', pluginOtherServer)).toBe(true)
    expect(matchesSelector('plugin:*', toolSearch)).toBe(false)
  })

  test('name wildcard within a concrete sub', () => {
    expect(matchesSelector('plugin:filesystem/*', pluginRead)).toBe(true)
    expect(matchesSelector('plugin:filesystem/*', pluginWrite)).toBe(true)
    expect(matchesSelector('plugin:filesystem/*', pluginOtherServer)).toBe(false)
  })

  test('different scope never matches', () => {
    expect(matchesSelector('tool:web_search', pluginRead)).toBe(false)
  })

  test('accepts a pre-parsed selector', () => {
    expect(matchesSelector(parseSelector('tool:web_search'), toolSearch)).toBe(true)
  })

  test('a partial glob prefix matches names sharing that prefix, not others', () => {
    const readFile: ToolOrigin = { scope: 'tool', name: 'read_file' }
    const readUrl: ToolOrigin = { scope: 'tool', name: 'read_url' }
    const writeFile: ToolOrigin = { scope: 'tool', name: 'write_file' }
    expect(matchesSelector('tool:read_*', readFile)).toBe(true)
    expect(matchesSelector('tool:read_*', readUrl)).toBe(true)
    expect(matchesSelector('tool:read_*', writeFile)).toBe(false)
  })

  test('a partial glob combines with a concrete or globbed sub', () => {
    const mcpFsRead: ToolOrigin = { scope: 'plugin', sub: 'mcp_fs', name: 'read_file' }
    const mcpGhRead: ToolOrigin = { scope: 'plugin', sub: 'mcp_github', name: 'read_issue' }
    const mcpFsWrite: ToolOrigin = { scope: 'plugin', sub: 'mcp_fs', name: 'write_file' }
    expect(matchesSelector('plugin:mcp_*/read_*', mcpFsRead)).toBe(true)
    expect(matchesSelector('plugin:mcp_*/read_*', mcpGhRead)).toBe(true)
    expect(matchesSelector('plugin:mcp_*/read_*', mcpFsWrite)).toBe(false)
  })

  test('a mid-segment wildcard matches names sharing both fragments', () => {
    const byId: ToolOrigin = { scope: 'tool', name: 'get_user_by_id' }
    const byName: ToolOrigin = { scope: 'tool', name: 'get_user_by_name' }
    expect(matchesSelector('tool:get_*_by_id', byId)).toBe(true)
    expect(matchesSelector('tool:get_*_by_id', byName)).toBe(false)
  })
})

describe('resolvePermissions', () => {
  const toolA: ToolOrigin = { scope: 'tool', name: 'a' }
  const toolB: ToolOrigin = { scope: 'tool', name: 'b' }
  const pluginRead: ToolOrigin = { scope: 'plugin', sub: 'filesystem', name: 'read' }
  const human: ToolOrigin = { scope: 'human', name: 'approve' }

  test('unset permissions defaults to allow-all, nothing gated', () => {
    const { allowed, gated } = resolvePermissions([toolA, toolB, pluginRead, human])
    expect(allowed).toEqual([toolA, toolB, pluginRead, human])
    expect(gated.size).toBe(0)
  })

  test('empty allow/ask/deny is a no-op (still allow-all)', () => {
    const { allowed, gated } = resolvePermissions([toolA, toolB], { allow: [], ask: [], deny: [] })
    expect(allowed).toEqual([toolA, toolB])
    expect(gated.size).toBe(0)
  })

  test('non-empty allow narrows the base set', () => {
    const { allowed } = resolvePermissions([toolA, toolB, pluginRead], { allow: ['tool:a'] })
    expect(allowed).toEqual([toolA])
  })

  test('deny always wins, even over an explicit allow', () => {
    const { allowed } = resolvePermissions([toolA, toolB], {
      allow: ['tool:*'],
      deny: ['tool:a'],
    })
    expect(allowed).toEqual([toolB])
  })

  test('ask wins over allow: an allowed+asked tool is gated, not free', () => {
    const { allowed, gated } = resolvePermissions([toolA], {
      allow: ['tool:a'],
      ask: ['tool:a'],
    })
    expect(allowed).toEqual([toolA])
    expect(gated.has(leafName(toolA))).toBe(true)
  })

  test('ask alone (no allow list) still admits the tool, gated', () => {
    const { allowed, gated } = resolvePermissions([toolA, toolB], { ask: ['tool:a'] })
    expect(allowed).toEqual([toolA, toolB])
    expect(gated.has(leafName(toolA))).toBe(true)
    expect(gated.has(leafName(toolB))).toBe(false)
  })

  test('deny beats ask too — a denied+asked tool is dropped entirely', () => {
    const { allowed, gated } = resolvePermissions([toolA], {
      ask: ['tool:a'],
      deny: ['tool:a'],
    })
    expect(allowed).toEqual([])
    expect(gated.size).toBe(0)
  })

  test('human-scope origins always pass through and are never gated', () => {
    const { allowed, gated } = resolvePermissions([human], {
      allow: ['tool:a'], // an allowlist that would otherwise exclude everything but tool:a
      ask: ['human:*'], // selector would be invalid if parsed, but human origins skip matching entirely
      deny: ['plugin:*'],
    })
    expect(allowed).toEqual([human])
    expect(gated.size).toBe(0)
  })

  test('scope wildcard deny drops every tool in that scope', () => {
    const { allowed } = resolvePermissions([toolA, pluginRead], { deny: ['plugin:*'] })
    expect(allowed).toEqual([toolA])
  })

  test('a partial glob deny drops only the matching tools, not their siblings', () => {
    const readFile: ToolOrigin = { scope: 'tool', name: 'read_file' }
    const writeFile: ToolOrigin = { scope: 'tool', name: 'write_file' }
    const { allowed } = resolvePermissions([readFile, writeFile], { deny: ['tool:read_*'] })
    expect(allowed).toEqual([writeFile])
  })
})
