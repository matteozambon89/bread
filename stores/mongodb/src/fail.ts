import { BreadError, redactConnectionSecrets, redactError } from '@breadai/core'

export function mongoCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

// Driver errors quote the command and sometimes the document. Keep the code,
// drop the text, so a cause cannot carry a URL, a principal, or stored text.
export function scrub(err: unknown): Error {
  const redacted = redactError(err)
  const clean = new Error('Store request failed.')
  if (redacted instanceof Error) clean.name = redacted.name
  const code = mongoCode(redacted)
  if (code !== undefined) (clean as { code?: number }).code = code
  return clean
}

export function queryFailed(err: unknown): never {
  if (err instanceof BreadError) throw err
  throw new BreadError('Store query failed.', 'STORE_QUERY_FAILED', {}, scrub(err))
}

export function journalError(err: unknown, fallback: string): BreadError {
  if (err instanceof BreadError) {
    return new BreadError(redactConnectionSecrets(err.message), err.code, err.context, redactError(err.cause))
  }
  const code = mongoCode(err)
  if (code === 13 || code === 18) {
    return new BreadError('Migration journal could not be read.', 'MIGRATION_JOURNAL_FORBIDDEN', {}, scrub(err))
  }
  if (code === 26) {
    return new BreadError('Migration journal is missing.', 'MIGRATION_JOURNAL_MISSING', {}, scrub(err))
  }
  return new BreadError(fallback, 'MIGRATION_FAILED', {}, scrub(err))
}
