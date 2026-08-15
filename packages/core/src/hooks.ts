import { nextBackoffDelay, sleep } from './retry.js'
import type { AfterRunResult, BeforeRunResult, OnErrorResult, RetryConfig } from './types.js'
import { BreadError } from './types.js'

// ---------------------------------------------------------------------------
// Hook chain runners — shared across Agent/Task/Tool/Loop scope. Each takes an
// ordered array of hook functions (scoped hook -> plugin hooks -> global hook,
// per scope's own call site) and resolves them per the unified
// beforeRun/afterRun/onError contract (see docs/agents.md).
// ---------------------------------------------------------------------------

export type MaybeHook<TFn> = TFn | undefined

export async function runBeforeRunChain<TInput, TOutput, TCtx>(
  hooks: Array<
    MaybeHook<
      (
        ctx: TCtx & { input: TInput },
      ) => Promise<BeforeRunResult<TInput, TOutput> | void> | BeforeRunResult<TInput, TOutput> | void
    >
  >,
  ctx: TCtx & { input: TInput },
): Promise<{ input: TInput; shortCircuited: boolean; output?: TOutput }> {
  let input = ctx.input
  for (const hook of hooks) {
    if (!hook) continue
    const result = await hook({ ...ctx, input })
    if (!result) continue
    if (result.action === 'shortCircuit') {
      return { input, shortCircuited: true, output: result.output }
    }
    input = result.input
  }
  return { input, shortCircuited: false }
}

export async function runAfterRunChain<TInput, TOutput, TCtx>(
  hooks: Array<
    MaybeHook<
      (
        ctx: TCtx & { input: TInput; output: TOutput; durationMs: number },
      ) => Promise<AfterRunResult<TOutput>> | AfterRunResult<TOutput>
    >
  >,
  ctx: TCtx & { input: TInput; output: TOutput; durationMs: number },
): Promise<TOutput> {
  let output = ctx.output
  for (const hook of hooks) {
    if (!hook) continue
    const result = await hook({ ...ctx, output })
    if (result) output = result.output
  }
  return output
}

// A single pass over the onError chain: returns the first non-void resolution,
// or undefined if every hook has no opinion. A hook throwing propagates
// directly (not caught here) — that stops the chain immediately, same as any
// other thrown error.
export async function runOnErrorChainOnce<TInput, TOutput, TErrCtx>(
  hooks: Array<
    MaybeHook<
      (
        ctx: TErrCtx & { input: TInput; error: BreadError },
      ) => Promise<OnErrorResult<TOutput>> | OnErrorResult<TOutput>
    >
  >,
  ctx: TErrCtx & { input: TInput; error: BreadError },
): Promise<OnErrorResult<TOutput>> {
  for (const hook of hooks) {
    if (!hook) continue
    const resolution = await hook(ctx)
    if (resolution) return resolution
  }
  return undefined
}

export async function runObserverChain<TCtx>(
  hooks: Array<((ctx: TCtx) => Promise<void> | void) | undefined>,
  ctx: TCtx,
): Promise<void> {
  for (const hook of hooks) {
    if (hook) await hook(ctx)
  }
}

export interface RetryDecision {
  action: 'recover' | 'retry' | 'fail' | 'stop'
  output?: unknown
  error?: BreadError
}

// Shared onError resolution bookkeeping (recover/retry/fail/stop). The actual
// retry mechanics (re-invoking the operation, sleeping between attempts)
// differ per call site — a plain async operation can use `runWithOnErrorRetry`
// below, but a generator that yields crumbs throughout (continueRun's main
// loop) can't be wrapped by a plain-callback helper and inlines its own loop,
// sharing only this decision step.
export function decideRetry(
  resolution: OnErrorResult<unknown>,
  breadErr: BreadError,
  retryConfig: RetryConfig | undefined,
  state: { attempt: number; usedUnconfiguredRetry: boolean },
): RetryDecision {
  if (resolution?.action === 'recover') return { action: 'recover', output: resolution.output }
  if (resolution?.action === 'fail') return { action: 'fail', error: resolution.error }
  let shouldRetry: boolean
  if (retryConfig) {
    shouldRetry = (resolution?.action === 'retry' || !resolution) && state.attempt < retryConfig.attempts
  } else {
    shouldRetry = resolution?.action === 'retry' && !state.usedUnconfiguredRetry
    if (shouldRetry) state.usedUnconfiguredRetry = true
  }
  return shouldRetry ? { action: 'retry' } : { action: 'stop', error: breadErr }
}

// Wraps `operation` with the onError chain and retry semantics: on failure,
// runs the chain fresh; `recover` resolves with a replacement output, `fail`
// throws a replacement error, `retry` (explicit, or the default when every
// hook is void and `retryConfig` is set) re-invokes `operation` after backoff.
// An explicit `retry` with no `retryConfig` performs exactly one immediate
// (no-backoff) retry. Once the bound is reached, the last error propagates
// regardless of what any hook returns on that final pass.
export async function runWithOnErrorRetry<TOutput>(
  operation: () => Promise<TOutput>,
  resolveError: (error: BreadError) => Promise<OnErrorResult<TOutput>>,
  toError: (err: unknown) => BreadError,
  retryConfig: RetryConfig | undefined,
): Promise<TOutput> {
  const state = { attempt: 1, usedUnconfiguredRetry: false }
  let delay = retryConfig?.backoffMs ?? 500

  for (;;) {
    try {
      return await operation()
    } catch (err) {
      // A delegated sub-run suspending for HITL escapes through its delegate
      // tool as DELEGATION_SUSPENDED — a suspension, not a failure. It must
      // reach the runner's chain-suspension path untouched: no onError chain,
      // and never a retry (that would re-run the whole delegation).
      if (err instanceof BreadError && err.code === 'DELEGATION_SUSPENDED') throw err
      const breadErr = toError(err)
      const resolution = await resolveError(breadErr)
      const decision = decideRetry(resolution, breadErr, retryConfig, state)

      if (decision.action === 'recover') return decision.output as TOutput
      if (decision.action !== 'retry') throw decision.error ?? breadErr

      if (retryConfig) {
        await sleep(delay)
        delay = nextBackoffDelay(delay, retryConfig)
      }
      state.attempt++
    }
  }
}
