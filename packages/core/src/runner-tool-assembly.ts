import { createDocTools } from './documents.js'
import { buildKgContext, createKgTools } from './kg.js'
import { buildLoopTools, loopSummary } from './loop.js'
import type { LoopRuntime } from './loop.js'
import { TOOL_SCOPES, leafName, resolvePermissions } from './permissions.js'
import type { ToolOrigin } from './permissions.js'
import { createTaskTool } from './task.js'
import {
  type SkillMeta,
  createLoadSkillTool,
  injectSkillPrompt,
  loadSkill,
  loadSkillTools,
  skillSummary,
} from './skills.js'
import { buildSupervisorTools, supervisorSummary } from './supervisor.js'
import type { SupervisorRuntime } from './supervisor.js'
import type { AssembledTools, ExecutableEntry, RunnerContext } from './runner-types.js'
import type {
  AgentConfig,
  BreadCrumb,
  HumanToolDefinition,
  RunOptions,
  ToolDefinition,
} from './types.js'
import { BreadError } from './types.js'

// Built-in tool defs already carry their full `core_`-prefixed name (see
// documents.ts/kg.ts/loop.ts/skills.ts) — strip it back off so leafName(origin)
// round-trips to the same string instead of double-prefixing.
export function coreOrigin(name: string): ToolOrigin {
  const prefix = `${TOOL_SCOPES.CORE}_`
  return { scope: TOOL_SCOPES.CORE, name: name.startsWith(prefix) ? name.slice(prefix.length) : name }
}

// Collects every tool source for one run segment — agent tools, plugin tools,
// built-in doc/kg/loop tools, tasks, skills, MCP — tags each with its
// structured origin, then resolves cfg.permissions to filter the allowed set
// and mark ask-gated leaves. Shared by continueRun (drives the model) and
// resumeRun (looks up the real tool behind an approved checkpoint), so both
// agree on exactly the same leaf names for the same config.
export async function assembleTools(
  agentId: string,
  cfg: AgentConfig<unknown, unknown>,
  runId: string,
  sessionId: string,
  opts: RunOptions,
  ctx: RunnerContext,
  onCrumb: (crumb: BreadCrumb) => void,
): Promise<AssembledTools> {
  const sources: ExecutableEntry[] = []

  // Agent-authored tools (cfg._tools, loader-injected).
  for (const def of ((cfg as any)._tools ?? []) as ToolDefinition[]) {
    sources.push({ origin: { scope: TOOL_SCOPES.TOOL, name: def.name }, def })
  }

  const humanDefs: HumanToolDefinition<any>[] = (cfg as any)._humanTools ?? []

  // Global tools contributed by plugins (config.plugins[].tools), merged in start().
  for (const { plugin, def } of ctx.pluginTools ?? []) {
    sources.push({ origin: { scope: TOOL_SCOPES.PLUGIN, sub: plugin, name: def.name }, def })
  }

  // Built-in document / knowledge-graph tools, auto-attached when the agent opts
  // into either feature and the store supports it.
  if (cfg.documents && ctx.store.readDocument) {
    for (const def of createDocTools(agentId, ctx.store)) sources.push({ origin: coreOrigin(def.name), def })
  }
  if (cfg.knowledge && ctx.store.addKnowledgeNode) {
    for (const def of createKgTools(agentId, ctx.store)) sources.push({ origin: coreOrigin(def.name), def })
  }

  // One-shot task tools: resolve each id the agent lists in `cfg.tasks` from the
  // registry and compile it into a tool.
  if (cfg.tasks?.length) {
    for (const taskId of cfg.tasks) {
      const taskDef = ctx.tasks?.get(taskId)
      if (!taskDef) {
        throw new BreadError(`Agent "${agentId}" references unknown task: "${taskId}".`, 'TASK_NOT_FOUND', {
          agentId,
          taskId,
          available: ctx.tasks ? [...ctx.tasks.keys()] : [],
        })
      }
      const def = createTaskTool(taskDef, {
        store: ctx.store,
        providers: [cfg.providers, ctx.providers],
        onCrumb,
        pluginHooks: ctx.pluginHooks,
        hooks: ctx.hooks,
      })
      sources.push({ origin: { scope: TOOL_SCOPES.TASK, name: def.name }, def })
    }
  }

  let system: string | undefined = ctx.systemPrompt ?? (cfg as any)._systemPrompt ?? undefined
  if (cfg.knowledge?.autoInject && ctx.store.knowledgeContext) {
    const kgCtx = await buildKgContext(ctx.store, agentId, sessionId, cfg.knowledge.maxTokens)
    if (kgCtx) system = system ? `${system}\n\n${kgCtx}` : kgCtx
  }

  // Skills. agentDir is attached by the CLI loader; without it (e.g. in-process
  // tests) skill loading is skipped.
  const agentDir = (cfg as any)._agentDir as string | undefined
  if (agentDir) {
    // Caller-driven: a specific skill requested for this run.
    if (opts.skill) {
      const skill = await loadSkill(agentDir, opts.skill)
      system = injectSkillPrompt(system ?? '', skill)
      for (const entry of await loadSkillTools(skill.id, skill.toolPaths)) {
        sources.push({
          origin: { scope: TOOL_SCOPES.SKILL, sub: entry.skillId, name: entry.def.name },
          def: entry.def,
        })
      }
    }
    // Agent-driven: expose discovered skills + a core_load_skill tool to pull them in.
    const skillsMeta = ((cfg as any)._skills ?? []) as Array<{ id: string; meta: SkillMeta }>
    if (skillsMeta.length > 0) {
      system = system ? `${system}\n\n${skillSummary(skillsMeta)}` : skillSummary(skillsMeta)
      const def = createLoadSkillTool(agentDir)
      sources.push({ origin: coreOrigin(def.name), def })
    }
  }

  // Per-agent tools resolved dynamically by a plugin, driven by that agent's
  // own cfg.plugins config (e.g. `@breadai/protocol-mcp-client` reading cfg.plugins.mcp_client
  // to connect servers this specific agent named). Opaque to core — a plugin
  // decides what its own config key means and what tools to return; core only
  // tags the result with that plugin's name for provenance/permission scoping,
  // identical to the static `plugin.tools` handled above.
  for (const { plugin, resolve } of ctx.pluginToolResolvers ?? []) {
    const defs = await resolve(agentId, cfg)
    for (const def of defs) {
      sources.push({ origin: { scope: TOOL_SCOPES.PLUGIN, sub: plugin, name: def.name }, def })
    }
  }

  // LLM-driven supervision: when configured, expose core_delegate and tell the
  // model about its sub-agent roster. The supervisor is otherwise a normal
  // agent run — its own output format, hooks, and HITL all apply.
  let supervisorRuntime: SupervisorRuntime | null = null
  if (cfg.supervisor) {
    supervisorRuntime = buildSupervisorTools({ supervisorCfg: cfg.supervisor, agentId, ctx, onCrumb })
    for (const def of supervisorRuntime.tools) sources.push({ origin: coreOrigin(def.name), def })
    const summary = supervisorSummary(cfg.supervisor)
    system = system ? `${system}\n\n${summary}` : summary
  }

  // Agent-driven loops: when configured, expose core_start_loop/core_iterate_loop/
  // core_finish_loop and tell the model about its agent pool.
  let loopRuntime: LoopRuntime | null = null
  if (cfg.loop) {
    loopRuntime = buildLoopTools({ loopCfg: cfg.loop, agentId, runId, sessionId, ctx, onCrumb })
    for (const def of loopRuntime.tools) sources.push({ origin: coreOrigin(def.name), def })
    system = system ? `${system}\n\n${loopSummary(cfg.loop)}` : loopSummary(cfg.loop)
  }

  // Permission resolution: (allow ∪ ask) − deny, deny wins, ask gates instead of
  // free execution. Human-scope origins are exempt from filtering entirely —
  // tracked separately below since they never go through the model's toolset
  // the same way (no execute, suspend unconditionally).
  const origins = sources.map((s) => s.origin)
  const { allowed, gated } = resolvePermissions(origins, cfg.permissions)
  const allowedSet = new Set(allowed)

  const executables = new Map<string, ExecutableEntry>()
  for (const s of sources) {
    if (!allowedSet.has(s.origin)) continue
    const leaf = leafName(s.origin)
    if (executables.has(leaf)) {
      throw new BreadError(
        `Multiple tools resolve to the same name "${leaf}" — rename one of them.`,
        'TOOL_NAME_COLLISION',
        { leaf },
      )
    }
    executables.set(leaf, s)
  }

  const humanLeaves = new Map<string, HumanToolDefinition<any>>()
  for (const d of humanDefs) {
    humanLeaves.set(leafName({ scope: TOOL_SCOPES.HUMAN, name: d.name }), d)
  }

  return { system, executables, humanLeaves, gated, loopRuntime, supervisorRuntime }
}
