import type { BreadInstance } from '@breadai/core'

// The slice of the public BreadInstance both spec-version handlers consume.
// store/transport/crumbFilter back the read-only task-lifecycle handlers
// (tasks/get, tasks/resubscribe) — they derive status from the crumb log
// instead of a persisted task registry. blobStore backs inline FilePart
// bytes — undefined when the host config didn't set one.
export type A2ABread = Pick<BreadInstance, 'run' | 'agents' | 'store' | 'transport' | 'crumbFilter' | 'blobStore'>

export interface AgentSkillMeta {
  id: string
  name: string
  description: string
  tags: string[]
}

export interface ResolvedAgentMeta {
  description: string
  skills: AgentSkillMeta[]
}

function firstLine(s: string | undefined): string | undefined {
  const trimmed = s?.trim()
  if (!trimmed) return undefined
  return (trimmed.split('\n')[0] ?? '').trim() || undefined
}

// Agent Card fields (v0.3 and v1.0's `AgentSkill` share the same
// {id, name, description, tags} shape) derived from the loader-injected
// private `_systemPrompt`/`_skills` fields — absent on plain in-process test
// agents, so both fall back to something generic rather than throwing.
export function resolveAgentMeta(bread: A2ABread, agentId: string, name: string): ResolvedAgentMeta {
  const agentDef = bread.agents.get(agentId)
  if (!agentDef) throw new Error(`a2a_server: agent "${agentId}" is not registered`)
  const cfg = agentDef.config as unknown as {
    _systemPrompt?: string
    _skills?: Array<{ id: string; meta: { name: string; description: string } }>
  }
  const description = firstLine(cfg._systemPrompt) ?? `Agent "${agentId}"`
  const skills: AgentSkillMeta[] =
    cfg._skills && cfg._skills.length > 0
      ? cfg._skills.map((s) => ({ id: s.id, name: s.meta.name, description: s.meta.description, tags: [] }))
      : [{ id: agentId, name, description, tags: [] }]
  return { description, skills }
}
