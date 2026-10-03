import { BreadError } from '@breadai/core'
import { assertInitTarget, runInit, runProviderAdd, runScaffoldInstall } from '@breadai/server'
import { finishWizard, withStatus } from './clack.js'
import { resolveInitChoices, type Ask, type InitChoices, type InitFlags } from './prompt.js'

function writeAfter(text: string): void {
  if (text.trim() === '') return
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

function nextSteps(root: string, choices: InitChoices): string {
  const lines = [`Scaffolded ${root}`]
  if (!choices.install) lines.push(`bread provider add ${choices.provider}`)
  lines.push('bread dev')
  if (choices.store === 'postgres') lines.push('Set DATABASE_URL')
  return lines.join('\n')
}

function announce(root: string, choices: InitChoices): void {
  for (const line of nextSteps(root, choices).split('\n')) console.log(`[bread] ${line}`)
}

async function addProvider(root: string, provider: string, interactive: boolean): Promise<void> {
  if (!interactive) {
    await runProviderAdd({ cwd: root, name: provider })
    return
  }
  const lines: string[] = []
  try {
    await withStatus(`Adding ${provider}`, () =>
      runProviderAdd({
        cwd: root,
        name: provider,
        log: (line) => lines.push(line),
      }),
    )
  } finally {
    writeAfter(lines.join('\n'))
  }
}

// Same markers and error as runInit. The CLI calls this before the first question.
export async function resolveScaffold(root: string, flags: InitFlags, tty: boolean, ask: Ask): Promise<InitChoices> {
  await assertInitTarget(root)
  return resolveInitChoices(flags, tty, ask)
}

async function addProviderOrExplain(root: string, provider: string, interactive: boolean): Promise<void> {
  try {
    await addProvider(root, provider, interactive)
  } catch (error) {
    const underlying = error instanceof Error ? error.message : String(error)
    throw new BreadError(
      `Project files were already written. A second bread init will refuse with SCAFFOLD_EXISTS. ${underlying}`,
      error instanceof BreadError ? error.code : 'PROVIDER_INSTALL_FAILED',
      error instanceof BreadError ? error.context : undefined,
      error,
    )
  }
}

// clackAsk exits 0 on cancel before this runs, so a cancelled question writes nothing.
export async function runScaffold(root: string, choices: InitChoices, interactive: boolean): Promise<void> {
  await runInit({
    dir: root,
    runtime: choices.runtime,
    store: choices.store,
    transport: choices.transport,
    agent: choices.agent,
    provider: choices.provider,
    model: choices.model,
    // Interactive install is captured below so its output follows the status line.
    noInstall: interactive || !choices.install,
    announce: false,
  })

  if (choices.install && interactive) {
    let output = ''
    try {
      output = await withStatus('Installing dependencies', () => runScaffoldInstall(root, { capture: true }))
    } catch (error) {
      if (error instanceof BreadError && typeof error.context?.output === 'string') output = error.context.output
      throw error
    } finally {
      writeAfter(output)
    }
  }
  if (choices.install) await addProviderOrExplain(root, choices.provider, interactive)

  if (interactive) finishWizard(nextSteps(root, choices))
  else announce(root, choices)
}
