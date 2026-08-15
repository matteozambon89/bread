import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BreadError, envProvider, injectSkillPrompt, loadSkill, loadSkillMeta } from '@bread/core'
import type { ToolContext } from '@bread/core'
// Runner-internal helpers not on the public surface — import from source.
import { createLoadSkillTool, loadSkillTools, skillSummary } from '../src/skills.js'

const agentDir = join(import.meta.dir, 'fixtures', 'agent')
const ctx: ToolContext = { agentId: 'a', sessionId: 's', runId: 'r', credentials: envProvider() }

describe('skills', () => {
  test('parses name and description from SKILL.md frontmatter', async () => {
    const meta = await loadSkillMeta(join(agentDir, 'skills', 'greet', 'SKILL.md'))
    expect(meta.name).toBe('greet')
    expect(meta.description).toBe('Greet a person warmly by name')
  })

  test('loads the full skill body', async () => {
    const skill = await loadSkill(agentDir, 'greet')
    expect(skill.id).toBe('greet')
    expect(skill.body).toContain('greet the user by their first name')
  })

  test('reads reference file content, not just paths', async () => {
    const skill = await loadSkill(agentDir, 'greet')
    expect(skill.references.length).toBe(1)
    expect(skill.references[0]!.name).toBe('tips.md')
    expect(skill.references[0]!.content).toContain('exclamation mark')
  })

  test('appends the skill body and reference content to the base system prompt', async () => {
    const skill = await loadSkill(agentDir, 'greet')
    const prompt = injectSkillPrompt('You are helpful.', skill)
    expect(prompt).toContain('You are helpful.')
    expect(prompt).toContain('## Skill: greet')
    expect(prompt).toContain('first name')
    expect(prompt).toContain('### Reference: tips.md')
    expect(prompt).toContain('exclamation mark')
  })

  test('discovers skill script tools and loads them as ToolDefinitions', async () => {
    const skill = await loadSkill(agentDir, 'greet')
    expect(skill.toolPaths.length).toBe(1)
    const tools = await loadSkillTools(skill.id, skill.toolPaths)
    expect(tools.map((t) => t.skillId)).toEqual(['greet'])
    expect(tools.map((t) => t.def.name)).toEqual(['wave'])
  })

  test('skillSummary lists available skills for the system prompt', () => {
    const summary = skillSummary([{ id: 'greet', meta: { name: 'greet', description: 'Say hi' } }])
    expect(summary).toContain('## Available Skills')
    expect(summary).toContain('greet: Say hi')
  })

  test('createLoadSkillTool loads a skill body on demand', async () => {
    const loader = createLoadSkillTool(agentDir)
    expect(loader.name).toBe('core_load_skill')
    const loaded = (await loader.execute({ skillId: 'greet' }, ctx)) as {
      instructions: string
      references: { name: string; content: string }[]
    }
    expect(loaded.instructions).toContain('first name')
    expect(loaded.references).toEqual([
      { name: 'tips.md', content: '# Greeting tips\n\nAlways end the greeting with an exclamation mark!\n' },
    ])
  })

  test('rejects a skill id that attempts path traversal', async () => {
    await expect(loadSkill(agentDir, '../evil')).rejects.toThrow(BreadError)
    await expect(loadSkill(agentDir, '../../etc/passwd')).rejects.toThrow(BreadError)
  })

  test('rejects a skill id with an embedded path separator', async () => {
    await expect(loadSkill(agentDir, 'evil/../../x')).rejects.toThrow(BreadError)
    await expect(loadSkill(agentDir, 'foo/bar')).rejects.toThrow(BreadError)
  })

  test('createLoadSkillTool also rejects a traversal skillId from the model', async () => {
    const loader = createLoadSkillTool(agentDir)
    await expect(loader.execute({ skillId: '../evil' }, ctx)).rejects.toThrow(BreadError)
  })
})
