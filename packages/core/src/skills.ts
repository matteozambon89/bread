import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { assertName } from './permissions.js'
import { BreadError } from './types.js'
import type { ToolDefinition } from './types.js'

// ---------------------------------------------------------------------------
// SKILL.md frontmatter
// ---------------------------------------------------------------------------

export interface SkillMeta {
  name: string
  description: string
}

export interface Skill {
  id: string
  meta: SkillMeta
  body: string
  toolPaths: string[]
  references: { name: string; content: string }[]
}

// Minimal YAML-like frontmatter parser (no external dep).
// Only supports flat key: value pairs as used in SKILL.md.
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  const match = FM_RE.exec(raw.trim())
  if (!match) return { meta: {}, body: raw }

  const [, fm, body] = match
  const meta: Record<string, string> = {}
  for (const line of (fm ?? '').split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    meta[key] = value
  }
  return { meta, body: body ?? '' }
}

// ---------------------------------------------------------------------------
// Skill loading
// ---------------------------------------------------------------------------

// Reads just the frontmatter from a SKILL.md — cheap at startup.
export async function loadSkillMeta(skillMdPath: string): Promise<SkillMeta> {
  const raw = await readFile(skillMdPath, 'utf8')
  const { meta } = parseFrontmatter(raw)
  return {
    name: meta['name'] ?? skillMdPath,
    description: meta['description'] ?? '',
  }
}

// Reads the full skill (frontmatter + body) on activation.
export async function loadSkill(
  agentDir: string,
  skillId: string,
): Promise<Skill> {
  assertName('skill', skillId)
  const skillsRoot = resolve(agentDir, 'skills')
  const skillDir = resolve(skillsRoot, skillId)
  // ponytail: second traversal guard is currently unreachable given assertName's
  // strictness (NAME_RE bars '/', '.', and any char that could resolve outside
  // skillsRoot) — defense in depth, not dead code.
  if (skillDir !== skillsRoot && !skillDir.startsWith(skillsRoot + sep)) {
    throw new BreadError(`skill id "${skillId}" escapes the skills directory`, 'INVALID_NAME', {
      kind: 'skill',
      value: skillId,
    })
  }
  const skillMdPath = join(skillDir, 'SKILL.md')
  const raw = await readFile(skillMdPath, 'utf8')
  const { meta, body } = parseFrontmatter(raw)

  // Collect tool files in skills/<id>/scripts/
  let toolPaths: string[] = []
  let references: { name: string; content: string }[] = []
  try {
    const { readdir } = await import('node:fs/promises')
    const scriptsDir = join(skillDir, 'scripts')
    const refsDir = join(skillDir, 'references')
    try {
      const files = await readdir(scriptsDir)
      toolPaths = files
        .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
        .map((f) => join(scriptsDir, f))
    } catch {}
    try {
      const files = await readdir(refsDir)
      // ponytail: no size cap on inlined reference content; add one if a
      // reference file ever blows out context.
      references = await Promise.all(
        files.map(async (f) => ({ name: f, content: await readFile(join(refsDir, f), 'utf8') })),
      )
    } catch {}
  } catch {}

  return {
    id: skillId,
    meta: {
      name: meta['name'] ?? skillId,
      description: meta['description'] ?? '',
    },
    body,
    toolPaths,
    references,
  }
}

// ---------------------------------------------------------------------------
// Skill injection
// ---------------------------------------------------------------------------

// Appends the skill prompt (and any reference material) to the base system
// prompt without replacing it.
export function injectSkillPrompt(basePrompt: string, skill: Skill): string {
  const refs = skill.references
    .map((r) => `\n\n### Reference: ${r.name}\n\n${r.content}`)
    .join('')
  return `${basePrompt}\n\n## Skill: ${skill.meta.name}\n\n${skill.body}${refs}`.trim()
}

// ---------------------------------------------------------------------------
// Skill tools
// ---------------------------------------------------------------------------

// A skill-sourced tool tagged with the skill it came from, so the runner can
// build its `skill:<id>/<name>` provenance without re-deriving it later.
export interface SkillToolEntry {
  skillId: string
  def: ToolDefinition
}

// Imports each skill script as a ToolDefinition (default or named `tool` export).
export async function loadSkillTools(skillId: string, toolPaths: string[]): Promise<SkillToolEntry[]> {
  const tools: SkillToolEntry[] = []
  for (const path of toolPaths) {
    try {
      const mod = await import(`${path}?t=${Date.now()}`)
      const def = mod.default ?? mod.tool
      if (def && !def._human) tools.push({ skillId, def: def as ToolDefinition })
    } catch (err) {
      throw new Error(`Failed to load skill tool ${path}: ${String(err)}`)
    }
  }
  return tools
}

// Summary of a skill's identity for system-prompt injection (agent-driven mode).
export function skillSummary(skills: Array<{ id: string; meta: SkillMeta }>): string {
  const lines = skills.map((s) => `- ${s.id}: ${s.meta.description || s.meta.name}`)
  return [
    '## Available Skills',
    'Call the `core_load_skill` tool with a `skillId` to load its full instructions before using it.',
    ...lines,
  ].join('\n')
}

// Built-in tool that lets an agent pull a skill's full body on demand. Only
// attached when the agent actually has skills on disk.
export function createLoadSkillTool(agentDir: string): ToolDefinition {
  const schema = z.object({
    skillId: z.string().describe('The id of the skill to load (its directory name)'),
  })
  return {
    name: 'core_load_skill',
    description: 'Load the full instructions for one of the available skills by id.',
    schema,
    async execute(args: { skillId: string }) {
      const skill = await loadSkill(agentDir, args.skillId)
      return {
        name: skill.meta.name,
        instructions: skill.body,
        ...(skill.toolPaths.length ? { scripts: skill.toolPaths } : {}),
        ...(skill.references.length ? { references: skill.references } : {}),
      }
    },
  } as ToolDefinition
}
