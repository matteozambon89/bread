// Connection failures quote the URL. Drop userinfo and password parameters
// before that text can be attached as a cause or printed.
export function redactConnectionSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1')
    .replace(/([?&#](?:password|pwd)=)[^&#\s]*/gi, '$1')
}

function redact(err: unknown, seen: WeakSet<object>): unknown {
  if (typeof err === 'string') return redactConnectionSecrets(err)
  if (err === null || typeof err !== 'object') return err
  if (seen.has(err)) return err
  seen.add(err)
  if (!(err instanceof Error)) return err
  const cause = err.cause === undefined ? undefined : redact(err.cause, seen)
  const redacted = new Error(
    redactConnectionSecrets(err.message),
    cause === undefined ? undefined : { cause },
  )
  redacted.name = err.name
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') {
    ;(redacted as { code?: string | number }).code = code
  }
  return redacted
}

export function redactError(err: unknown): unknown {
  return redact(err, new WeakSet())
}
