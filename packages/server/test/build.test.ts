import { join } from 'node:path'
import { describe, expect, spyOn, test } from 'bun:test'
import { runBuild } from '@bread/server'

const goodRoot = join(import.meta.dir, 'fixtures', 'build-project')
const invalidRoot = join(import.meta.dir, 'fixtures', 'build-project-invalid')

class ProcessExitSignal extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

describe('runBuild', () => {
  test('succeeds and logs a summary when every agent is fully configured', async () => {
    const logSpy = spyOn(console, 'log')
    try {
      await runBuild({ cwd: goodRoot })
      const printed = logSpy.mock.calls.flat().join('\n')
      expect(printed).toContain('Build succeeded — 1 agent(s)')
    } finally {
      logSpy.mockRestore()
    }
  })

  test('exits with code 1, reporting a missing schema and an incomplete model config', async () => {
    const errorSpy = spyOn(console, 'error')
    const origExit = process.exit
    let exitCode: number | undefined
    process.exit = ((code?: number) => {
      exitCode = code
      throw new ProcessExitSignal(code ?? 0)
    }) as never

    try {
      await expect(runBuild({ cwd: invalidRoot })).rejects.toThrow(ProcessExitSignal)
      const printed = errorSpy.mock.calls.flat().join('\n')
      expect(printed).toContain('has incomplete model config')
      expect(printed).toContain('missing_schema_agent" missing inputSchema')
      expect(printed).toContain('missing_schema_agent" missing outputSchema')
      expect(printed).toContain('Build failed with 3 error(s)')
    } finally {
      process.exit = origExit
      errorSpy.mockRestore()
    }

    expect(exitCode).toBe(1)
  })
})
