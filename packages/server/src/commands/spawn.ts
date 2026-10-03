async function readPipe(stream: unknown): Promise<string> {
  if (!stream || typeof stream !== 'object') return ''
  try {
    return await new Response(stream as ReadableStream<Uint8Array>).text()
  } catch {
    return ''
  }
}

// A SIGINT listener replaces Node's default exit. Kill the child and exit
// non-zero so Ctrl+C cannot leave the command running and report success.
export async function spawnCommand(
  cmd: string[],
  cwd: string,
  capture: boolean,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: capture ? 'pipe' : 'inherit',
    stderr: capture ? 'pipe' : 'inherit',
  })
  const onSigint = (): never => {
    try {
      proc.kill('SIGINT')
    } catch {
      // Child may have already exited.
    }
    process.exit(130)
  }
  process.on('SIGINT', onSigint)
  try {
    const captured = capture
      ? Promise.all([readPipe(proc.stdout), readPipe(proc.stderr)]).then(([out, err]) => `${out}${err}`)
      : Promise.resolve('')
    const [exitCode, output] = await Promise.all([proc.exited, captured])
    return { exitCode: exitCode ?? 130, output }
  } finally {
    process.off('SIGINT', onSigint)
  }
}
