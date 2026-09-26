import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertName, BreadError } from '@breadai/core'
import { assertAgentId, pathExists } from '../scaffold/names.js'
import { skillSource } from '../scaffold/templates.js'

export interface SkillAddOptions {
  cwd: string
  agent: string
  id: string
  description?: string
}

export async function runSkillAdd(opts: SkillAddOptions): Promise<void> {
  assertName('skill', opts.id)
  assertAgentId(opts.agent)
  const root = resolve(opts.cwd)
  const configPath = join(root, 'bread.config.ts')
  if (!(await pathExists(configPath))) {
    throw new BreadError(`No bread project at ${root} (missing bread.config.ts).`, 'PROJECT_NOT_FOUND', {
      cwd: root,
    })
  }
  const agentFile = join(root, 'agents', opts.agent, 'agent.ts')
  if (!(await pathExists(agentFile))) {
    throw new BreadError(
      `Agent "${opts.agent}" was not found (missing agents/${opts.agent}/agent.ts).`,
      'AGENT_NOT_FOUND',
      { agent: opts.agent, cwd: root },
    )
  }
  const skillDir = join(root, 'agents', opts.agent, 'skills', opts.id)
  if (await pathExists(skillDir)) {
    throw new BreadError(`Skill "${opts.id}" already exists at ${skillDir}. Nothing was written.`, 'SCAFFOLD_EXISTS', {
      agent: opts.agent,
      id: opts.id,
    })
  }
  const markdown =
    opts.description === undefined ? skillSource(opts.id) : skillSource(opts.id, opts.description)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), markdown)
  console.log(`[bread] Added skill ${opts.id}`)
}
