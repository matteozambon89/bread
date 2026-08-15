import { resolve } from 'node:path'

// Shared plumbing for driving the real `bread` binary as a subprocess — these
// tests exercise `src/bin.ts`/`src/cli.ts` exactly as a user's terminal would,
// not the `@bread/server` command functions directly (those are already
// covered in packages/server/test). `--conditions bread-source` mirrors the
// package's own `dev` script — running TS source, not a built dist.
const binPath = resolve(import.meta.dir, '../src/bin.ts')

export interface SpawnedCli {
  proc: ReturnType<typeof Bun.spawn>
  /** Write one line (newline-appended) to the child's stdin and flush it. */
  writeLine(line: string): void
  /** Block until `marker` has appeared in accumulated stdout, or time out. */
  readUntil(marker: string, timeoutMs?: number): Promise<string>
  /** Everything read from stdout so far. */
  stdoutSoFar(): string
  /** Everything read from stderr so far. */
  stderrSoFar(): string
}

export function spawnCli(args: string[], opts: { cwd?: string; stdin?: 'pipe' | 'ignore' } = {}): SpawnedCli {
  const proc = Bun.spawn({
    cmd: [process.execPath, '--conditions', 'bread-source', binPath, ...args],
    cwd: opts.cwd,
    stdin: opts.stdin ?? 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })

  const decoder = new TextDecoder()
  let out = ''
  let err = ''

  // Bun's ReadableStream is directly async-iterable — no getReader() needed,
  // and iterating (rather than buffering via .text()) is what lets readUntil
  // observe output incrementally while the process is still running.
  void (async () => {
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      out += decoder.decode(chunk, { stream: true })
    }
  })().catch(() => {})
  void (async () => {
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      err += decoder.decode(chunk, { stream: true })
    }
  })().catch(() => {})

  return {
    proc,
    writeLine(line) {
      if (opts.stdin === 'ignore') throw new Error('spawnCli: stdin was opened with { stdin: "ignore" }')
      // proc.stdin (opened via 'pipe') is a FileSink: write() buffers,
      // flush() is what actually sends it to the child.
      const sink = proc.stdin as { write(chunk: string): number; flush(): number | Promise<number> }
      sink.write(`${line}\n`)
      sink.flush()
    },
    async readUntil(marker, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      while (!out.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(marker)}\n` +
              `--- stdout so far ---\n${out}\n--- stderr so far ---\n${err}`,
          )
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      return out
    },
    stdoutSoFar: () => out,
    stderrSoFar: () => err,
  }
}

export const FIXTURES = resolve(import.meta.dir, 'fixtures')
