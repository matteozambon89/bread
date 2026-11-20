import { resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { parseServeArgs } from '../src/args.ts'

test('parseServeArgs keeps --no-migrate and resolves cwd', () => {
  const flags = parseServeArgs(['start', '--cwd', 'proj', '--port', '3001', '--no-migrate'], '/fallback')
  expect(flags).toEqual({
    command: 'start',
    cwd: resolve('proj'),
    port: 3001,
    noMigrate: true,
  })
})

test('parseServeArgs omits --no-migrate when the flag is absent', () => {
  const flags = parseServeArgs(['dev', '--host', '127.0.0.1'], '/work')
  expect(flags.noMigrate).toBeUndefined()
  expect(flags).toEqual({ command: 'dev', cwd: '/work', host: '127.0.0.1' })
})

test('parseServeArgs rejects an unknown argument', () => {
  expect(() => parseServeArgs(['start', '--migrate', 'true'], '/work')).toThrow(/Unknown argument/)
})
