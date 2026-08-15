import { v7 as uuidv7 } from 'uuid'
import { createCrumbLogWriter } from './crumb-log.js'
import { BreadEventBus } from './event-bus.js'
import { assertName } from './permissions.js'
import { runPipeline as runPipelineCore } from './pipeline.js'
import { type AgentRegistry, buildToolCredentials, resumeRun, runAgent } from './runner.js'
import { type TaskRegistry, createTaskTool } from './task.js'
import type { BlobStore, FileOutput } from './storage/blob-store.js'
import type { BreadStore } from './storage/store.js'
import { type BreadTransport, streamTransport, toWireCrumb } from './transport.js'
import {
  type BreadConfig,
  type BreadCrumb,
  type BreadHooks,
  type BreadInstance,
  type BreadPlugin,
  BreadError,
  type CancellableOptions,
  type CredentialProvider,
  type HumanRequiredEvent,
  type RunOptions,
  type ToolContext,
  type ToolDefinition,
} from './types.js'

export function createBread(
  config: BreadConfig,
  agents: AgentRegistry = new Map(),
  tasks: TaskRegistry = new Map(),
): BreadInstance {
  // Local listener registry behind bread.on('crumb'/'human:required') —
  // in-process only, distinct from the cross-replica `fabric` below.
  let events: BreadEventBus | null = null
  // The crumb fabric (config.transport or the embedded Stream default): every
  // crumb leaving a public stream is published here as a { runId, seq, crumb } frame.
  let fabric: BreadTransport | null = null
  let store: BreadStore | null = null
  let inFlight = 0
  // Global tools contributed by plugins, collected from config.plugins on start,
  // tagged with the contributing plugin's name for plugin:<name>/<tool> provenance.
  let pluginTools: { plugin: string; def: ToolDefinition }[] = []
  // Per-agent tool resolvers contributed by plugins (BreadPlugin.resolveAgentTools),
  // called once per agent during tool assembly — unlike `pluginTools` above, these
  // run per-run since they're driven by that agent's own cfg.plugins config.
  let pluginToolResolvers: { plugin: string; resolve: NonNullable<BreadPlugin['resolveAgentTools']> }[] = []
  // Plugin-contributed global hooks, in config.plugins registration order —
  // the middle link of every scope's beforeRun/afterRun/onError/onSuspend
  // chain (scoped hook -> pluginHooks -> BreadConfig.hooks).
  let pluginHooks: Partial<BreadHooks>[] = []

  function requireStarted(): BreadEventBus {
    if (!events) throw new Error('BreadInstance not started — call bread.start() first')
    return events
  }

  function requireStore(): BreadStore {
    if (!store) throw new Error('BreadInstance not started — call bread.start() first')
    return store
  }

  function requireTransport(): BreadTransport {
    if (!fabric) throw new Error('BreadInstance not started — call bread.start() first')
    return fabric
  }

  function toHumanRequiredEvent(crumb: BreadCrumb & { type: 'human:required' }): HumanRequiredEvent {
    return {
      agentId: crumb.agentId,
      runId: crumb.runId,
      sessionId: crumb.sessionId,
      checkpointId: crumb.checkpointId,
      toolName: crumb.toolName,
      schema: crumb.schema,
      ...(crumb.prompt !== undefined ? { prompt: crumb.prompt } : {}),
      kind: crumb.kind,
    }
  }

  // The per-run choke point: every public stream (run/resume/runPipeline) is
  // wrapped here, so this is the single place crumbs get their seq, are
  // written to the durable crumb log, reach local listeners (bread.on), and
  // are published to the fabric. By construction the transport view and the
  // log equal the client-visible stream — supervisor filtering, remote relays
  // and pipeline framing have all been applied upstream.
  async function* instrument(inner: AsyncIterable<BreadCrumb>): AsyncGenerator<BreadCrumb> {
    // Sequencing + delta aggregation + log writes live in the writer; state is
    // per runId (a stream can interleave supervisor children, pipeline steps).
    const writer = createCrumbLogWriter({ store })
    try {
      for await (const raw of inner) {
        const crumb = await writer.process(raw)

        events?.emit('crumb', crumb)
        if (crumb.type === 'human:required') {
          events?.emit('human:required', toHumanRequiredEvent(crumb))
        }

        const runId = (crumb as { runId?: string }).runId
        if (fabric && runId !== undefined && crumb.seq !== undefined && (!config.crumbFilter || config.crumbFilter(crumb))) {
          // Fire-and-forget: the transport is liveness-only, a publish failure
          // must never fail the run. Per-run ordering is the implementation's
          // contract given publishes happen in stream order.
          try {
            const res = fabric.publish({ runId, seq: crumb.seq, crumb: toWireCrumb(crumb) })
            if (res instanceof Promise) {
              res.catch((err) => console.warn(`[bread] transport publish failed (run ${runId}):`, err))
            }
          } catch (err) {
            console.warn(`[bread] transport publish failed (run ${runId}):`, err)
          }
        }

        yield crumb
      }
    } finally {
      // Flush open delta windows + settle pending log writes, also when the
      // consumer abandons the stream early.
      await writer.finalize()
    }
  }

  const instance = {
    async start() {
      events = await BreadEventBus.create()
      fabric = config.transport ?? streamTransport()
      await fabric.init?.()

      if (!config.store) {
        throw new BreadError(
          'No store configured. Set `store` in your config — e.g. `store()` from ' +
            '`@bread/store-postgres` (reads DATABASE_URL), `store({ path: \'./bread.db\' })` ' +
            'from `@bread/store-sqlite`, or `store()` from `@bread/store-memory`.',
          'STORE_NOT_CONFIGURED',
        )
      }
      store = config.store
      await store.migrate?.()

      if (config.plugins) {
        for (const plugin of config.plugins) {
          assertName('plugin', plugin.name)
          // Merge plugin contributions: pre-built agents and global tools.
          if (plugin.agents) {
            for (const [id, def] of Object.entries(plugin.agents)) agents.set(id, def)
          }
          if (plugin.tools) {
            for (const def of plugin.tools) assertName('plugin tool', def.name)
            pluginTools.push(...plugin.tools.map((def) => ({ plugin: plugin.name, def })))
          }
          if (plugin.resolveAgentTools) {
            pluginToolResolvers.push({ plugin: plugin.name, resolve: plugin.resolveAgentTools })
          }
          if (plugin.hooks) pluginHooks.push(plugin.hooks)
          await plugin.init?.(instance as unknown as BreadInstance)
        }
      }

      // Remote-agent lifecycle: remote agents that hold connections open them here,
      // after plugins (a plugin may contribute the credentials a remote agent signs with).
      for (const remote of Object.values(config.remoteAgents ?? {})) {
        await remote.init?.()
      }
    },

    async stop() {
      for (const remote of Object.values(config.remoteAgents ?? {})) {
        await remote.close?.()
      }
      if (config.plugins) {
        for (const plugin of config.plugins) {
          await plugin.close?.()
        }
      }
      pluginTools = []
      pluginToolResolvers = []
      pluginHooks = []
      await store?.close?.()
      await fabric?.close?.()
      await events?.close()
      events = null
      fabric = null
      store = null
    },

    run(agentId: string, input: unknown, opts?: RunOptions): any {
      requireStarted()
      const s = requireStore()

      const max = config.concurrency?.max ?? Number.POSITIVE_INFINITY

      const runCtx = {
        store: s,
        agents,
        tasks,
        providers: config.providers,
        pluginTools,
        pluginToolResolvers,
        remoteAgents: config.remoteAgents,
        credentials: config.credentials,
        pluginHooks,
        hooks: config.hooks,
        onHumanRequired: opts?.onHumanRequired,
        signal: opts?.signal,
        blobStore: config.blobStore,
      }

      if (opts?.mode === 'sync') {
        // Sync mode drains the same instrumented stream, so bus/log/listeners
        // see a sync run exactly like a streamed one. The IIFE begins executing
        // immediately (no external iteration needed), so check+increment here
        // are already co-located with the decrement below.
        if (inFlight >= max) {
          throw new BreadError(`Max concurrency reached (${max})`, 'CONCURRENCY_LIMIT', {
            inFlight,
            max,
          })
        }
        inFlight++
        return (async () => {
          try {
            let output: unknown
            let files: FileOutput[] | undefined
            for await (const crumb of instrument(runAgent(agentId, input, opts ?? {}, runCtx))) {
              if (crumb.type === 'agent:run:end') {
                output = crumb.output
                files = crumb.files
              }
            }
            return { output, ...(files?.length ? { files } : {}) }
          } finally {
            inFlight--
          }
        })()
      }
      // Check+increment live inside the generator body (before the try) so an
      // un-iterated generator never holds a slot — the cap surfaces on first
      // iteration instead of at call time.
      return (async function* () {
        if (inFlight >= max) {
          throw new BreadError(`Max concurrency reached (${max})`, 'CONCURRENCY_LIMIT', {
            inFlight,
            max,
          })
        }
        inFlight++
        try {
          yield* instrument(runAgent(agentId, input, opts ?? {}, runCtx))
        } finally {
          inFlight--
        }
      })()
    },

    resume(checkpointId: string, response: unknown, opts?: CancellableOptions): AsyncGenerator<BreadCrumb> {
      requireStarted()
      const s = requireStore()
      const max = config.concurrency?.max ?? Number.POSITIVE_INFINITY
      const runCtx = {
        store: s,
        agents,
        tasks,
        providers: config.providers,
        pluginTools,
        pluginToolResolvers,
        remoteAgents: config.remoteAgents,
        credentials: config.credentials,
        pluginHooks,
        hooks: config.hooks,
        signal: opts?.signal,
        blobStore: config.blobStore,
      }
      return (async function* () {
        if (inFlight >= max) {
          throw new BreadError(`Max concurrency reached (${max})`, 'CONCURRENCY_LIMIT', {
            inFlight,
            max,
          })
        }
        inFlight++
        try {
          yield* instrument(resumeRun(checkpointId, response, runCtx))
        } finally {
          inFlight--
        }
      })()
    },

    runPipeline(pipelineId: string, input: unknown, opts?: CancellableOptions): AsyncIterable<BreadCrumb> {
      requireStarted()
      const s = requireStore()
      const steps = config.pipelines?.[pipelineId]
      if (!steps) {
        throw new BreadError(`Pipeline not found: "${pipelineId}"`, 'PIPELINE_NOT_FOUND', {
          pipelineId,
          available: Object.keys(config.pipelines ?? {}),
        })
      }

      const max = config.concurrency?.max ?? Number.POSITIVE_INFINITY

      const runCtx = {
        store: s,
        agents,
        tasks,
        providers: config.providers,
        pluginTools,
        pluginToolResolvers,
        remoteAgents: config.remoteAgents,
        credentials: config.credentials,
        pluginHooks,
        hooks: config.hooks,
        signal: opts?.signal,
        blobStore: config.blobStore,
      }
      return (async function* () {
        if (inFlight >= max) {
          throw new BreadError(`Max concurrency reached (${max})`, 'CONCURRENCY_LIMIT', {
            inFlight,
            max,
          })
        }
        inFlight++
        try {
          yield* instrument(runPipelineCore({ pipelineId, steps, input, ctx: runCtx }))
        } finally {
          inFlight--
        }
      })()
    },

    async runTask(
      taskId: string,
      args: unknown,
      opts?: { agentId?: string; sessionId?: string; runId?: string },
    ): Promise<unknown> {
      requireStarted()
      const s = requireStore()
      const def = tasks.get(taskId)
      if (!def) {
        throw new BreadError(`Task not found: "${taskId}"`, 'TASK_NOT_FOUND', {
          taskId,
          available: [...tasks.keys()],
        })
      }
      const max = config.concurrency?.max ?? Number.POSITIVE_INFINITY
      if (inFlight >= max) {
        throw new BreadError(`Max concurrency reached (${max})`, 'CONCURRENCY_LIMIT', {
          inFlight,
          max,
        })
      }
      inFlight++
      try {
        // No onCrumb: a standalone task has no host run stream, so it is
        // crumb-silent; the TaskRunRecord audit via the store applies in full.
        const tool = createTaskTool(def, {
          store: s,
          providers: [config.providers],
          pluginHooks,
          hooks: config.hooks,
        })
        const id = uuidv7()
        const toolCtx: ToolContext = {
          agentId: opts?.agentId ?? 'standalone',
          sessionId: opts?.sessionId ?? id,
          runId: opts?.runId ?? id,
          credentials: buildToolCredentials(tool, config.credentials),
        }
        return await tool.execute(args, toolCtx)
      } finally {
        inFlight--
      }
    },

    on(event: string, handler: (...args: unknown[]) => unknown): void {
      requireStarted().on(event as 'crumb', handler as (crumb: BreadCrumb) => void)
    },

    off(event: string, handler: (...args: unknown[]) => unknown): void {
      events?.off(event, handler)
    },

    get store(): BreadStore {
      return requireStore()
    },

    get blobStore(): BlobStore | undefined {
      return config.blobStore
    },

    get transport(): BreadTransport {
      return requireTransport()
    },

    get agents(): ReadonlyMap<string, unknown> {
      return agents
    },

    get tasks(): ReadonlyMap<string, unknown> {
      return tasks
    },

    get pluginTools(): ReadonlyArray<{ plugin: string; def: ToolDefinition }> {
      return pluginTools
    },

    get credentials(): CredentialProvider | undefined {
      return config.credentials
    },

    get crumbFilter(): ((crumb: BreadCrumb) => boolean) | undefined {
      return config.crumbFilter
    },
  } as unknown as BreadInstance

  return instance
}
