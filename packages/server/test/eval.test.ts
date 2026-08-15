import { join } from 'node:path'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { runEvalCommand } from '@breadai/server'
import { mockTextModel } from '@breadai/test-utils'

const projectRoot = join(import.meta.dir, 'fixtures', 'eval-project')
const emptyRoot = join(import.meta.dir, 'fixtures', 'eval-project-empty')

class ProcessExitSignal extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`)
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__breadEvalTestModel']
})

describe('runEvalCommand', () => {
  test('runs the discovered eval suite, prints per-case results, and exits 1 on any failure', async () => {
    ;(globalThis as Record<string, unknown>)['__breadEvalTestModel'] = mockTextModel('agent output')

    const logSpy = spyOn(console, 'log')
    const origExit = process.exit
    let exitCode: number | undefined
    process.exit = ((code?: number) => {
      exitCode = code
      throw new ProcessExitSignal(code ?? 0)
    }) as never

    let printed = ''
    try {
      await expect(runEvalCommand({ cwd: projectRoot })).rejects.toThrow(ProcessExitSignal)
      printed = logSpy.mock.calls.flat().join('\n')
    } finally {
      process.exit = origExit
      logSpy.mockRestore()
    }

    expect(exitCode).toBe(1)
    expect(printed).toContain('✓ matches')
    expect(printed).toContain('✗ mismatches')
    expect(printed).toContain('1/2 passed')
    expect(printed).toContain('Total: 1 passed, 1 failed')
  })

  test('prints "No eval files found" and returns early when there are none', async () => {
    const logSpy = spyOn(console, 'log')
    try {
      await runEvalCommand({ cwd: emptyRoot })
      expect(logSpy.mock.calls.flat().join('\n')).toContain('No eval files found')
    } finally {
      logSpy.mockRestore()
    }
  })
})
