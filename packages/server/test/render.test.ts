import { describe, expect, test } from 'bun:test'
import { parseHumanResponse } from '../src/commands/render.js'

describe('parseHumanResponse', () => {
  test('parses valid JSON input into an object', () => {
    expect(parseHumanResponse('{"ok":true,"n":1}')).toEqual({ ok: true, n: 1 })
  })

  test('parses a JSON scalar', () => {
    expect(parseHumanResponse('42')).toBe(42)
  })

  test('falls back to the raw trimmed string when input is not JSON', () => {
    expect(parseHumanResponse('yes')).toBe('yes')
  })

  test('trims surrounding whitespace before parsing', () => {
    expect(parseHumanResponse('  {"ok":true}  ')).toEqual({ ok: true })
  })

  test('empty input returns the trimmed (empty) string', () => {
    expect(parseHumanResponse('   ')).toBe('')
  })
})
