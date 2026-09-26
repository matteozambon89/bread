import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertName, BreadError } from '@breadai/core'
import { assertKnownProvider, assertModelId } from '../scaffold/catalog.js'
import { insertEntrypoint } from '../scaffold/entrypoints.js'
import { assertAgentId, pathExists } from '../scaffold/names.js'
import { PROMPT_MD, agentSource, evalSource } from '../scaffold/templates.js'

export interface AgentAddOptions {
  cwd: string
  id: string
  provider: string
  model: string
}

export interface AgentEvalOptions {
  cwd: string
  agent: string
  name: string
}

async function requireProject(cwd: string): Promise<{ root: string; configPath: string }> {
  const root = resolve(cwd)
  const configPath = join(root, 'bread.config.ts')
  if (!(await pathExists(configPath))) {
    throw new BreadError(`No bread project at ${root} (missing bread.config.ts).`, 'PROJECT_NOT_FOUND', {
      cwd: root,
    })
  }
  return { root, configPath }
}

async function requireAgentFile(root: string, agent: string): Promise<void> {
  const agentFile = join(root, 'agents', agent, 'agent.ts')
  if (!(await pathExists(agentFile))) {
    throw new BreadError(
      `Agent "${agent}" was not found (missing agents/${agent}/agent.ts).`,
      'AGENT_NOT_FOUND',
      { agent, cwd: root },
    )
  }
}

async function removeNewAgent(agentDir: string, agentFile: string, promptFile: string): Promise<void> {
  await rm(agentFile, { force: true })
  await rm(promptFile, { force: true })
  await rmdir(agentDir).catch(() => {})
}

export async function runAgentAdd(opts: AgentAddOptions): Promise<void> {
  assertAgentId(opts.id)
  const provider = assertKnownProvider(opts.provider)
  const model = assertModelId(opts.model)
  const { root, configPath } = await requireProject(opts.cwd)
  const agentDir = join(root, 'agents', opts.id)
  if (await pathExists(agentDir)) {
    throw new BreadError(`Agent "${opts.id}" already exists at ${agentDir}. Nothing was written.`, 'SCAFFOLD_EXISTS', {
      id: opts.id,
    })
  }

  const source = await readFile(configPath, 'utf8')
  const updated = insertEntrypoint(source, opts.id)
  const agentFile = join(agentDir, 'agent.ts')
  const promptFile = join(agentDir, 'prompt.md')
  const tmp = `${configPath}.${process.pid}.tmp`

  await mkdir(agentDir, { recursive: true })
  try {
    await writeFile(agentFile, agentSource(provider, model))
    await writeFile(promptFile, PROMPT_MD)
    await writeFile(tmp, updated)
    await rename(tmp, configPath)
  } catch (err) {
    await rm(tmp, { force: true })
    await removeNewAgent(agentDir, agentFile, promptFile)
    throw err
  }

  console.log(`[bread] Added agent ${opts.id}`)
}

export async function runAgentEval(opts: AgentEvalOptions): Promise<void> {
  assertName('eval', opts.name)
  assertAgentId(opts.agent)
  const { root } = await requireProject(opts.cwd)
  await requireAgentFile(root, opts.agent)
  const evalFile = join(root, 'agents', opts.agent, 'evals', `${opts.name}.eval.ts`)
  if (await pathExists(evalFile)) {
    throw new BreadError(`Eval "${opts.name}" already exists at ${evalFile}. Nothing was written.`, 'SCAFFOLD_EXISTS', {
      agent: opts.agent,
      name: opts.name,
    })
  }
  await mkdir(join(root, 'agents', opts.agent, 'evals'), { recursive: true })
  await writeFile(evalFile, evalSource(opts.agent))
  console.log(`[bread] Added eval ${opts.name}`)
}
