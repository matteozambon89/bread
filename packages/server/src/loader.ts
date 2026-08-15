import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  type AgentDefinition,
  type AgentRegistry,
  type BreadConfig,
  type SkillMeta,
  type TaskDefinition,
  type TaskRegistry,
  type ToolDefinition,
  assertName,
  loadSkillMeta,
  parseSelector,
} from '@bread/core'

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export async function loadConfig(projectRoot: string): Promise<BreadConfig> {
  const configPath = resolve(projectRoot, 'bread.config.ts')
  // Cache-bust so a re-import sees on-disk edits (hot reload) rather than the
  // cached module.
  const mod = await import(`${configPath}?t=${Date.now()}`)
  const config: BreadConfig = mod.default ?? mod.config
  if (!config) throw new Error(`bread.config.ts must export a default BreadConfig`)
  return config
}

// ---------------------------------------------------------------------------
// Agent loader
// ---------------------------------------------------------------------------

export async function loadAgents(
  projectRoot: string,
  entrypoints: string[],
): Promise<AgentRegistry> {
  const registry: AgentRegistry = new Map()

  for (const agentId of entrypoints) {
    const agentDir = resolve(projectRoot, 'agents', agentId)
    const agentFile = join(agentDir, 'agent.ts')

    let mod: any
    try {
      // Cache-bust so `bread dev` re-imports fresh code on hot reload — Bun
      // otherwise returns the cached module and re-serves stale agent code.
      mod = await import(`${agentFile}?t=${Date.now()}`)
    } catch (err) {
      console.error(`[bread] Failed to load agent "${agentId}" from ${agentFile}:`, err)
      continue
    }

    const def: AgentDefinition<unknown, unknown> = mod.default ?? mod.agent
    if (!def || !def._agentDef) {
      console.error(`[bread] ${agentFile} must export a default AgentDefinition (use defineAgent)`)
      continue
    }

    // Load system prompt from prompt.md
    let systemPrompt = ''
    try {
      systemPrompt = await readFile(join(agentDir, 'prompt.md'), 'utf8')
    } catch {}
    ;(def.config as any)._systemPrompt = systemPrompt

    // Load tools from agents/<id>/tools/*.ts
    const tools = await loadTools(agentDir)
    ;(def.config as any)._tools = tools.regular
    ;(def.config as any)._humanTools = tools.human

    // Skill metadata from agents/<id>/skills/<id>/SKILL.md (full body loaded
    // lazily at run time). _agentDir lets the runner resolve skills on demand.
    ;(def.config as any)._agentDir = agentDir
    ;(def.config as any)._skills = await loadSkillsMeta(agentDir)

    // A typo'd selector (e.g. "mpc:*") must fail loudly here, not silently
    // match nothing at run time.
    const permissions = def.config.permissions
    for (const selector of [
      ...(permissions?.allow ?? []),
      ...(permissions?.ask ?? []),
      ...(permissions?.deny ?? []),
    ]) {
      parseSelector(selector)
    }

    registry.set(agentId, def)
  }

  return registry
}

// ---------------------------------------------------------------------------
// Task loader — scans tasks/*.ts into a registry keyed by each task's `name`.
// ---------------------------------------------------------------------------

export async function loadTasks(projectRoot: string): Promise<TaskRegistry> {
  const registry: TaskRegistry = new Map()
  const tasksDir = resolve(projectRoot, 'tasks')

  let files: string[]
  try {
    files = await readdir(tasksDir)
  } catch {
    return registry
  }

  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.js')) continue
    const taskPath = join(tasksDir, file)
    let def: TaskDefinition<unknown, unknown> | undefined
    try {
      // Cache-bust so `bread dev` re-imports fresh task code on hot reload.
      const mod = await import(`${taskPath}?t=${Date.now()}`)
      def = mod.default ?? mod.task
    } catch (err) {
      console.error(`[bread] Failed to load task ${taskPath}:`, err)
      continue
    }
    if (!def || !def._taskDef) {
      console.error(`[bread] ${taskPath} must export a default TaskDefinition (use defineTask)`)
      continue
    }
    assertName('task', def.config.name)
    registry.set(def.config.name, def)
  }

  return registry
}

// ---------------------------------------------------------------------------
// Tool loader
// ---------------------------------------------------------------------------

async function loadTools(agentDir: string): Promise<{
  regular: ToolDefinition[]
  human: any[]
}> {
  const toolsDir = join(agentDir, 'tools')
  const regular: ToolDefinition[] = []
  const human: any[] = []

  try {
    await stat(toolsDir)
  } catch {
    return { regular, human }
  }

  const files = await readdir(toolsDir)
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.js')) continue
    const toolPath = join(toolsDir, file)
    let def: any
    try {
      const mod = await import(`${toolPath}?t=${Date.now()}`)
      def = mod.default ?? mod.tool
    } catch (err) {
      console.error(`[bread] Failed to load tool ${toolPath}:`, err)
      continue
    }
    if (!def) continue
    // A non-conforming name is a loud config error, not a skip — unlike an
    // import failure, this is the developer's tool definition, not the host
    // environment, so it should fail the load rather than be silently dropped.
    if (def._human) {
      assertName('human', def.name)
      human.push(def)
    } else {
      assertName('tool', def.name)
      regular.push(def as ToolDefinition)
    }
  }

  return { regular, human }
}

// ---------------------------------------------------------------------------
// Skill loader (metadata only — bodies are loaded lazily at run time)
// ---------------------------------------------------------------------------

async function loadSkillsMeta(
  agentDir: string,
): Promise<Array<{ id: string; meta: SkillMeta }>> {
  const skillsDir = join(agentDir, 'skills')
  const out: Array<{ id: string; meta: SkillMeta }> = []

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    assertName('skill', entry.name)
    const skillMd = join(skillsDir, entry.name, 'SKILL.md')
    try {
      const meta = await loadSkillMeta(skillMd)
      out.push({ id: entry.name, meta })
    } catch (err) {
      console.error(`[bread] Failed to load skill "${entry.name}":`, err)
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Eval loader
// ---------------------------------------------------------------------------

export async function loadEvals(projectRoot: string, scopePath?: string): Promise<any[]> {
  const evals: any[] = []
  const baseDir = scopePath ? resolve(projectRoot, scopePath) : resolve(projectRoot, 'agents')

  async function scan(dir: string) {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      const s = await stat(full).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) {
        await scan(full)
      } else if (entry.endsWith('.eval.ts') || entry.endsWith('.eval.js')) {
        try {
          const mod = await import(`${full}?t=${Date.now()}`)
          const def = mod.default ?? mod.evalDef
          if (def?._evalDef) evals.push(def)
        } catch (err) {
          console.error(`[bread] Failed to load eval ${full}:`, err)
        }
      }
    }
  }

  await scan(baseDir)
  return evals
}
