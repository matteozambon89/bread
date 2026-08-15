import type { ErrorHandlingConfig } from './types.js'
import { BreadError } from './types.js'

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: ErrorHandlingConfig['retry'],
  context: string,
): Promise<T> {
  const attempts = config?.attempts ?? 1
  let lastError: unknown
  let delay = config?.backoffMs ?? 500

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        await sleep(delay)
        delay = nextBackoffDelay(delay, config)
      }
    }
  }

  throw new BreadError(
    `Failed after ${attempts} attempt(s): ${context}`,
    'MAX_RETRIES_EXCEEDED',
    { attempts, context },
    lastError,
  )
}

// Shared backoff policy, also used by the hook-aware retry loop in runner.ts
// (which can't use withRetry directly since it needs to run the onError hook
// chain between attempts rather than retrying silently).
export function nextBackoffDelay(currentDelayMs: number, config: ErrorHandlingConfig['retry']): number {
  return Math.round(currentDelayMs * (config?.backoffMultiplier ?? 2))
}

// An optional signal lets a cancelled run skip out of a backoff wait early
// instead of sitting out the full delay before the next attempt notices.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
