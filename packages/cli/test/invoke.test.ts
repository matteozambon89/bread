import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { FIXTURES, spawnCli } from './spawn-helper.js'

// `bread invoke` at the binary level — --cwd resolution (relative to the
// spawn's own cwd, not just an already-absolute path), stdin piping, and the
// exit codes a script driving this CLI would actually branch on. The command
// function itself (runInvoke) is already covered in packages/server/test;
// this covers cli.ts's own translation layer (enterProjectRoot, readStdin,
// the empty-input exit(1) branch) that nothing else exercises.

const repoRoot = resolve(FIXTURES, '../../../..')
const relativeFixturePath = 'packages/cli/test/fixtures/echo-project'
const absoluteFixturePath = resolve(FIXTURES, 'echo-project')

describe('bread invoke — --cwd resolution', () => {
  test('a relative --cwd resolves against the process it was spawned from, not this test file', async () => {
    const cli = spawnCli(['invoke', 'echo', 'hi', '--cwd', relativeFixturePath], { cwd: repoRoot })
    const exitCode = await cli.proc.exited
    expect(exitCode).toBe(0)
    expect(cli.stdoutSoFar()).toContain('echoed')
  })

  test('a nonexistent --cwd fails clearly instead of silently running from the wrong directory', async () => {
    const cli = spawnCli(['invoke', 'echo', 'hi', '--cwd', '/definitely/not/a/real/path/xyz'])
    const exitCode = await cli.proc.exited
    expect(exitCode).not.toBe(0)
    expect(cli.stderrSoFar()).toContain('--cwd directory does not exist')
  })
})

describe('bread invoke — stdin', () => {
  test('input piped via stdin is used when no argument is given', async () => {
    const cli = spawnCli(['invoke', 'echo', '--cwd', absoluteFixturePath])
    ;(cli.proc.stdin as { write(s: string): unknown; end(): unknown }).write('piped input')
    ;(cli.proc.stdin as { end(): unknown }).end()
    const exitCode = await cli.proc.exited
    expect(exitCode).toBe(0)
    expect(cli.stdoutSoFar()).toContain('echoed')
  })

  test('an explicit argument wins over stdin when both are present', async () => {
    const cli = spawnCli(['invoke', 'echo', 'the argument', '--cwd', absoluteFixturePath])
    // Never read if the argument already won — closing anyway proves the
    // process doesn't block waiting on it.
    ;(cli.proc.stdin as { end(): unknown }).end()
    const exitCode = await cli.proc.exited
    expect(exitCode).toBe(0)
  })
})

describe('bread invoke — exit codes', () => {
  test('empty stdin and no argument exits 1 with a clear stderr message, not a hang', async () => {
    const cli = spawnCli(['invoke', 'echo', '--cwd', absoluteFixturePath])
    ;(cli.proc.stdin as { end(): unknown }).end() // closes immediately empty — readStdin() resolves to ''
    const exitCode = await cli.proc.exited
    expect(exitCode).toBe(1)
    expect(cli.stderrSoFar()).toContain('No input provided')
  })

  test('a successful invoke exits 0', async () => {
    const cli = spawnCli(['invoke', 'echo', 'hi', '--cwd', absoluteFixturePath])
    const exitCode = await cli.proc.exited
    expect(exitCode).toBe(0)
  })

  test('an unknown agent id exits non-zero', async () => {
    const cli = spawnCli(['invoke', 'ghost', 'hi', '--cwd', absoluteFixturePath])
    const exitCode = await cli.proc.exited
    expect(exitCode).not.toBe(0)
  })
})
