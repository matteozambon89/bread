import { redactConnectionSecrets, redactError } from '@breadai/core'

const PASSWORD_PARAM = /((?:password|pwd)\s*=\s*)[^;\s]*/gi

function scrub(text: string): string {
  return redactConnectionSecrets(text).replace(PASSWORD_PARAM, '$1')
}

export function driverNumber(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const record = err as {
    number?: unknown
    originalError?: { number?: unknown; info?: { number?: unknown } }
  }
  if (typeof record.number === 'number') return record.number
  if (typeof record.originalError?.number === 'number') return record.originalError.number
  const info = record.originalError?.info?.number
  return typeof info === 'number' ? info : undefined
}

export function redactDriver(err: unknown): unknown {
  if (!(err instanceof Error)) return redactError(err)
  const scrubbed = new Error(scrub(err.message))
  scrubbed.name = err.name
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') {
    ;(scrubbed as { code?: string | number }).code = code
  }
  if (err.cause !== undefined) scrubbed.cause = redactDriver(err.cause)
  return redactError(scrubbed)
}

export function isDuplicateIndex(err: unknown): boolean {
  const number = driverNumber(err)
  return number === 1913 || number === 2714
}
