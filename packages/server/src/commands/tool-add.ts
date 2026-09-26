import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertName, BreadError } from '@breadai/core'
import { assertAgentId, pathExists } from '../scaffold/names.js'
import { humanToolSource, toolSource } from '../scaffold/templates.js'

export interface ToolAddOptions {
  cwd: string
  agent: string
  name: string
  human?: boolean
}

export async function runToolAdd(opts: ToolAddOptions): Promise<void> {
  assertName('tool', opts.name)
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
  const toolFile = join(root, 'agents', opts.agent, 'tools', `${opts.name}.ts`)
  if (await pathExists(toolFile)) {
    throw new BreadError(`Tool "${opts.name}" already exists at ${toolFile}. Nothing was written.`, 'SCAFFOLD_EXISTS', {
      agent: opts.agent,
      name: opts.name,
    })
  }
  await mkdir(join(root, 'agents', opts.agent, 'tools'), { recursive: true })
  await writeFile(toolFile, opts.human ? humanToolSource(opts.name) : toolSource(opts.name))
  console.log(`[bread] Added tool ${opts.name}`)
}
