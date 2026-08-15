import { generateObject } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { runAfterRunChain, runBeforeRunChain, runOnErrorChainOnce, runWithOnErrorRetry } from './hooks.js'
import { modelCallOptions, type ProviderRegistry, resolveModel } from './model-provider.js'
import type { BreadStore } from './storage/store.js'
import {
  type BreadCrumb,
  type BreadHooks,
  type GlobalHookContext,
  type TaskDefinition,
  type TaskRunContext,
  type TaskUsage,
  type ToolContext,
  type ToolDefinition,
} from './types.js'
import { BreadError } from './types.js'

// Keyed by `config.name` (the tool identity the LLM sees and `config.tasks`
// references).
export type TaskRegistry = Map<string, TaskDefinition<unknown, unknown>>

export interface TaskToolDeps {
  store: BreadStore
  // Ordered registries — first match wins (e.g. [agentProviders, globalProviders]).
  providers?: (ProviderRegistry | undefined)[] | undefined
  // Sink surfacing task:* crumbs in the host run's stream. Absent for
  // standalone invocations (no run to attach to) — those are crumb-silent.
  onCrumb?: ((crumb: BreadCrumb) => void) | undefined
  // Global hook chain tail — see RunnerContext.pluginHooks/hooks in runner.ts.
  pluginHooks?: Partial<BreadHooks>[] | undefined
  hooks?: Partial<BreadHooks> | undefined
}

function toTaskError(err: unknown, taskName: string): BreadError {
  if (err instanceof BreadError) return err
  return new BreadError(err instanceof Error ? err.message : String(err), 'TASK_ERROR', { taskName }, err)
}

// Builds the ordered [scoped, ...plugins, global] hook array for one
// beforeRun/afterRun/onError key, same pattern as runner.ts's agentHookChain
// (Tasks have no onSuspend — they never suspend for HITL).
function taskHookChain<K extends 'beforeRun' | 'afterRun' | 'onError'>(
  cfg: TaskDefinition<unknown, unknown>['config'],
  deps: TaskToolDeps,
  key: K,
): Array<BreadHooks[K] | undefined> {
  return [
    cfg.hooks?.[key] as unknown as BreadHooks[K] | undefined,
    ...(deps.pluginHooks ?? []).map((h) => h[key]),
    deps.hooks?.[key],
  ]
}

interface ExecuteTaskContext {
  providers?: (ProviderRegistry | undefined)[] | undefined
  store: BreadStore
  run: { agentId: string; runId: string; sessionId: string }
  onCrumb?: ((crumb: BreadCrumb) => void) | undefined
  signal?: AbortSignal | undefined
}

function toUsage(usage: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
}): TaskUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}

// Run the model for a task: resolve the model, drive a single `generateObject`,
// and wrap it with `task:*` crumbs + an audited `TaskRunRecord` (best-effort).
// Returns the structured object; pre/post shaping happens in `createTaskTool`.
async function executeTask(
  def: TaskDefinition<unknown, unknown>,
  llmInput: unknown,
  ctx: ExecuteTaskContext,
): Promise<unknown> {
  const cfg = def.config
  const id = uuidv7()
  const startedAt = Date.now()

  const model = await resolveModel(cfg.model, ctx.providers)

  await ctx.store.createTaskRun?.({
    id,
    taskId: cfg.name,
    ...ctx.run,
    model: cfg.model,
    input: llmInput,
    status: 'running',
    createdAt: startedAt,
  })

  const emit = (crumb: BreadCrumb) => {
    ctx.onCrumb?.(crumb)
  }
  emit({
    type: 'task:start',
    ...ctx.run,
    timestamp: startedAt,
    taskRunId: id,
    taskId: cfg.name,
    model: cfg.model,
  })

  try {
    const result = await generateObject({
      model,
      schema: cfg.outputSchema,
      prompt: `${cfg.instructions}\n\nInput:\n${JSON.stringify(llmInput, null, 2)}`,
      ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
      ...modelCallOptions(cfg.model),
    })
    const durationMs = Date.now() - startedAt
    const usage = result.usage ? toUsage(result.usage) : undefined

    await ctx.store.finishTaskRun?.(id, {
      status: 'completed',
      output: result.object,
      ...(usage ? { usage } : {}),
      durationMs,
      completedAt: Date.now(),
    })
    emit({
      type: 'task:end',
      ...ctx.run,
      timestamp: Date.now(),
      taskRunId: id,
      taskId: cfg.name,
      status: 'completed',
      durationMs,
      ...(usage ? { usage } : {}),
    })
    return result.object
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const message = err instanceof Error ? err.message : String(err)
    await ctx.store.finishTaskRun?.(id, {
      status: 'failed',
      error: message,
      durationMs,
      completedAt: Date.now(),
    })
    emit({
      type: 'task:end',
      ...ctx.run,
      timestamp: Date.now(),
      taskRunId: id,
      taskId: cfg.name,
      status: 'failed',
      durationMs,
      error: message,
    })
    throw err
  }
}

// Compile a task into an LLM-callable tool. The tool's `execute` runs the
// beforeRun chain (task hook -> plugin hooks -> global hooks; may override the
// model input or short-circuit), the model call (via `executeTask`, wrapped
// with onError's recover/retry/fail resolution), then the afterRun chain
// (may replace the output).
export function createTaskTool(
  def: TaskDefinition<unknown, unknown>,
  deps: TaskToolDeps,
): ToolDefinition {
  const cfg = def.config
  return {
    name: cfg.name,
    description: cfg.description,
    schema: cfg.schema,
    async execute(args, ctx: ToolContext): Promise<unknown> {
      const hookCtx: TaskRunContext = {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        taskName: cfg.name,
        credentials: ctx.credentials,
        store: deps.store,
      }

      const before = await runBeforeRunChain<unknown, unknown, GlobalHookContext>(
        taskHookChain(cfg, deps, 'beforeRun'),
        { scope: 'task', ...hookCtx, input: args },
      )
      const llmInput = before.input

      if (before.shortCircuited) {
        return runAfterRunChain<unknown, unknown, GlobalHookContext>(taskHookChain(cfg, deps, 'afterRun'), {
          scope: 'task',
          ...hookCtx,
          input: llmInput,
          output: before.output,
          durationMs: 0,
        })
      }

      const run = { agentId: ctx.agentId, runId: ctx.runId, sessionId: ctx.sessionId }
      const start = Date.now()
      const output = await runWithOnErrorRetry<unknown>(
        () =>
          executeTask(def, llmInput, {
            providers: deps.providers,
            store: deps.store,
            run,
            onCrumb: deps.onCrumb,
            signal: ctx.signal,
          }),
        (error) =>
          runOnErrorChainOnce<unknown, unknown, GlobalHookContext>(taskHookChain(cfg, deps, 'onError'), {
            scope: 'task',
            ...hookCtx,
            input: llmInput,
            error,
          }),
        (err) => toTaskError(err, cfg.name),
        cfg.errorHandling?.retry,
      )

      return runAfterRunChain<unknown, unknown, GlobalHookContext>(taskHookChain(cfg, deps, 'afterRun'), {
        scope: 'task',
        ...hookCtx,
        input: llmInput,
        output,
        durationMs: Date.now() - start,
      })
    },
  }
}
