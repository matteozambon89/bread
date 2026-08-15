import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadAgents, loadConfig, loadEvals, loadTasks } from '@bread/server'

const fixturesRoot = join(import.meta.dir, 'fixtures')
const projectRoot = join(fixturesRoot, 'project')

describe('loadAgents', () => {
  test('loads an agent definition from agents/<id>/agent.ts', async () => {
    const registry = await loadAgents(projectRoot, ['greeter'])
    const def = registry.get('greeter')
    expect(def?._agentDef).toBe(true)
    expect(def?.config.model).toMatchObject({ provider: 'openai' })
  })

  test('injects the system prompt, tools, skills and agent dir', async () => {
    const registry = await loadAgents(projectRoot, ['greeter'])
    const cfg = registry.get('greeter')!.config as Record<string, unknown>

    expect(cfg._systemPrompt).toContain('friendly greeter')
    expect((cfg._tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['echo'])
    expect((cfg._skills as Array<{ id: string }>).map((s) => s.id)).toEqual(['wave'])
    expect(cfg._agentDir).toContain(join('agents', 'greeter'))
  })

  test('skips unknown entrypoints without throwing', async () => {
    const registry = await loadAgents(projectRoot, ['ghost'])
    expect(registry.has('ghost')).toBe(false)
  })

  test('throws when an agent has a malformed permission selector', async () => {
    await expect(loadAgents(projectRoot, ['bad_permissions'])).rejects.toThrow(/invalid permission selector/i)
  })

  test('throws when a tool name is not snake_case', async () => {
    await expect(loadAgents(projectRoot, ['bad_tool_name'])).rejects.toThrow(/must match/i)
  })

  test('skips an agent module with no default AgentDefinition export', async () => {
    const registry = await loadAgents(projectRoot, ['bad_agent_export'])
    expect(registry.has('bad_agent_export')).toBe(false)
  })

  test('skips a tool file that throws on import, keeping the agent usable', async () => {
    const registry = await loadAgents(projectRoot, ['tool_import_failure'])
    const cfg = registry.get('tool_import_failure')!.config as Record<string, unknown>
    expect(cfg._tools).toEqual([])
  })

  test('routes a `_human` tool export into _humanTools, not _tools', async () => {
    const registry = await loadAgents(projectRoot, ['human_tool'])
    const cfg = registry.get('human_tool')!.config as Record<string, unknown>
    expect(cfg._tools).toEqual([])
    expect((cfg._humanTools as Array<{ name: string }>).map((t) => t.name)).toEqual(['confirm'])
  })

  test('skips a skill whose SKILL.md is missing, keeping the agent usable', async () => {
    const registry = await loadAgents(projectRoot, ['bad_skill'])
    const cfg = registry.get('bad_skill')!.config as Record<string, unknown>
    expect(cfg._skills).toEqual([])
  })
})

describe('loadConfig', () => {
  test('throws when bread.config.ts has no default (or named `config`) export', async () => {
    await expect(loadConfig(join(fixturesRoot, 'bad-config'))).rejects.toThrow(
      /must export a default BreadConfig/,
    )
  })
})

describe('loadTasks', () => {
  test('loads a valid task, skipping an import failure and a missing export', async () => {
    const registry = await loadTasks(projectRoot)
    expect([...registry.keys()]).toEqual(['summarize'])
    expect(registry.get('summarize')?._taskDef).toBe(true)
  })

  test('returns an empty registry when there is no tasks/ dir', async () => {
    const registry = await loadTasks(fixturesRoot)
    expect(registry.size).toBe(0)
  })
})

describe('loadEvals', () => {
  test('loads valid evals recursively, skipping an import failure and a missing export', async () => {
    const evals = await loadEvals(fixturesRoot, 'evals')
    expect(evals).toHaveLength(2)
    expect(evals.every((e) => e._evalDef)).toBe(true)
    expect(evals.map((e) => e.config.agentId)).toEqual(['greeter', 'greeter'])
  })

  test('defaults its scan to <projectRoot>/agents when no scopePath is given', async () => {
    const evals = await loadEvals(fixturesRoot)
    expect(evals).toEqual([])
  })
})
