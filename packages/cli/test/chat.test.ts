import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { FIXTURES, spawnCli } from './spawn-helper.js'

// `bread chat`'s HITL flow, driven through the real binary — Commander →
// runChat's readline REPL → human:required → resume → continuation. This is
// the one path packages/server/test can't cover: runChat reads real
// process.stdin/writes real process.stdout, so it needs a real subprocess,
// not a direct function call.

const chatProject = resolve(FIXTURES, 'chat-project')

describe('bread chat — HITL flow (real subprocess)', () => {
  test('a human-tool call pauses the REPL for input, then resumes and finishes', async () => {
    const cli = spawnCli(['chat', 'assistant', '--cwd', chatProject])
    try {
      await cli.readUntil('you ▸')
      cli.writeLine('hello there')

      // The mock model calls the human tool on turn one — the REPL must
      // print a prompt and block instead of hanging silently or crashing.
      await cli.readUntil('needs input')
      expect(cli.stdoutSoFar()).toContain('ask_human')

      cli.writeLine('My name is Ada')

      // resumeRun's continuation runs the second scripted model turn.
      await cli.readUntil('Thanks — got your answer.')

      cli.writeLine('/exit')
      const exitCode = await cli.proc.exited
      expect(exitCode).toBe(0)
    } finally {
      cli.proc.kill()
    }
  }, 15000)

  test('Ctrl-D (stdin closing) shuts the REPL down cleanly instead of hanging', async () => {
    const cli = spawnCli(['chat', 'assistant', '--cwd', chatProject])
    try {
      await cli.readUntil('you ▸')
      ;(cli.proc.stdin as { end(): unknown }).end()

      const exitCode = await cli.proc.exited
      expect(exitCode).toBe(0)
    } finally {
      cli.proc.kill()
    }
  }, 15000)
})
