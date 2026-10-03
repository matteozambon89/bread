import { BreadError } from '@breadai/core'

export interface PromptChoice {
  value: string
  label: string
}

export interface SelectPrompt {
  kind: 'select'
  name: 'runtime' | 'store' | 'transport'
  message: string
  options: PromptChoice[]
  initialValue: string
}

export interface TextPrompt {
  kind: 'text'
  name: 'agent' | 'provider' | 'model' | 'id' | 'name'
  message: string
  initialValue?: string
  placeholder?: string
}

export interface ConfirmPrompt {
  kind: 'confirm'
  name: 'install'
  message: string
  initialValue: boolean
}

export type Prompt = SelectPrompt | TextPrompt | ConfirmPrompt

export type Ask = (prompt: Prompt) => Promise<unknown> | unknown

export interface InitFlags {
  runtime?: string
  store?: string
  transport?: string
  agent?: string
  /** Set only when the flag was passed. Undefined means the wizard may ask. */
  install?: boolean
  provider?: string
  model?: string
}

export interface InitChoices {
  runtime: 'bun' | 'node'
  store: 'sqlite' | 'memory' | 'postgres'
  transport: 'chunked' | 'sse'
  agent: string
  install: boolean
  provider: string
  model: string
}

export type AddKind = 'agent' | 'tool' | 'skill' | 'eval'

export interface AddFlags {
  kind: AddKind
  id?: string
  agent?: string
  name?: string
  description?: string
  provider?: string
  model?: string
}

export interface AddNames {
  id?: string
  agent?: string
  name?: string
  description?: string
  provider?: string
  model?: string
}

const RUNTIMES = ['bun', 'node'] as const
const STORES = ['sqlite', 'memory', 'postgres'] as const
const TRANSPORTS = ['chunked', 'sse'] as const

type Runtime = (typeof RUNTIMES)[number]
type Store = (typeof STORES)[number]
type Transport = (typeof TRANSPORTS)[number]

// Same rule as scaffold assertAgentId. A typed id is asked again so nothing
// is written yet; a passed --agent flag is not re-asked (runInit rejects it).
const AGENT_ID_RE = /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/

const REQUIRED: Record<AddKind, Array<'id' | 'agent' | 'name'>> = {
  agent: ['id'],
  tool: ['agent', 'name'],
  skill: ['agent', 'id'],
  eval: ['agent', 'name'],
}

const LABELS = {
  id: '<id>',
  agent: '<agent>',
  name: '<name>',
} as const

const ADD_MESSAGES: Record<AddKind, Partial<Record<'id' | 'agent' | 'name', string>>> = {
  agent: { id: 'Agent id' },
  tool: { agent: 'Agent', name: 'Tool name' },
  skill: { agent: 'Agent', id: 'Skill id' },
  eval: { agent: 'Agent', name: 'Eval name' },
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  const trimmed = clean(value)
  if (trimmed === undefined) return undefined
  if (!(allowed as readonly string[]).includes(trimmed)) {
    throw new BreadError(
      `Unsupported ${flag} "${trimmed}". Supported: ${allowed.join(', ')}.`,
      'SCAFFOLD_INVALID_NAME',
      { flag, value: trimmed },
    )
  }
  return trimmed as T
}

function choices(values: readonly string[]): PromptChoice[] {
  return values.map((value) => ({ value, label: value }))
}

function storesFor(runtime: Runtime): readonly Store[] {
  return runtime === 'node' ? ['memory', 'postgres'] : STORES
}

function defaultStore(runtime: Runtime): Store {
  return runtime === 'node' ? 'memory' : 'sqlite'
}

function missingFlag(flag: string): never {
  throw new BreadError(
    `Missing ${flag}. Pass ${flag}. There is no default. Nothing was written.`,
    'SCAFFOLD_INVALID_NAME',
    { flag },
  )
}

async function askSelect<T extends string>(ask: Ask, prompt: SelectPrompt): Promise<T> {
  const value = await ask(prompt)
  const picked = isBlank(value) ? prompt.initialValue : typeof value === 'string' ? value.trim() : ''
  const allowed = prompt.options.map((option) => option.value)
  if (!allowed.includes(picked)) {
    throw new BreadError(
      `Unsupported ${prompt.name} "${picked}". Supported: ${allowed.join(', ')}.`,
      'SCAFFOLD_INVALID_NAME',
      { name: prompt.name, value: picked },
    )
  }
  return picked as T
}

async function askAgent(ask: Ask): Promise<string> {
  let message = 'Agent id'
  for (;;) {
    const value = await ask({
      kind: 'text',
      name: 'agent',
      message,
      initialValue: 'assistant',
    })
    const id = isBlank(value) ? 'assistant' : typeof value === 'string' ? value.trim() : ''
    if (AGENT_ID_RE.test(id)) return id
    message = `Agent id must match ${AGENT_ID_RE}`
  }
}

async function askInstall(ask: Ask): Promise<boolean> {
  const value = await ask({
    kind: 'confirm',
    name: 'install',
    message: 'Install dependencies?',
    initialValue: true,
  })
  if (isBlank(value)) return true
  if (typeof value === 'boolean') return value
  throw new BreadError('Install must be yes or no.', 'SCAFFOLD_INVALID_NAME', { name: 'install', value })
}

// No initial value. A blank answer is asked again; it is not a skip.
async function askRequiredText(ask: Ask, name: 'provider' | 'model', message: string): Promise<string> {
  for (;;) {
    const value = await ask({ kind: 'text', name, message })
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
}

async function providerAndModel(flags: InitFlags, tty: boolean, ask: Ask): Promise<{ provider: string; model: string }> {
  const providerFlag = clean(flags.provider)
  const modelFlag = clean(flags.model)
  if (!tty) {
    if (providerFlag === undefined) missingFlag('--provider')
    if (modelFlag === undefined) missingFlag('--model')
    return { provider: providerFlag, model: modelFlag }
  }
  return {
    provider: providerFlag ?? (await askRequiredText(ask, 'provider', 'Catalog provider')),
    model: modelFlag ?? (await askRequiredText(ask, 'model', 'Model id')),
  }
}

// A non-TTY never calls ask. An empty answer is Enter: keep the default,
// except provider and model, which have no default and are asked again.
export async function resolveInitChoices(flags: InitFlags, tty: boolean, ask: Ask): Promise<InitChoices> {
  const runtimeFlag = pick(flags.runtime, RUNTIMES, '--runtime')
  const storeFlag = pick(flags.store, STORES, '--store')
  const transportFlag = pick(flags.transport, TRANSPORTS, '--transport')
  const agentFlag = clean(flags.agent)

  if (!tty) {
    const runtime = runtimeFlag ?? 'bun'
    const { provider, model } = await providerAndModel(flags, tty, ask)
    return {
      runtime,
      store: storeFlag ?? defaultStore(runtime),
      transport: transportFlag ?? 'chunked',
      agent: agentFlag ?? 'assistant',
      install: flags.install !== false,
      provider,
      model,
    }
  }

  const runtime =
    runtimeFlag ??
    (await askSelect<Runtime>(ask, {
      kind: 'select',
      name: 'runtime',
      message: 'Runtime',
      options: choices(RUNTIMES),
      initialValue: 'bun',
    }))
  const storeOptions = storesFor(runtime)
  const store =
    storeFlag ??
    (await askSelect<Store>(ask, {
      kind: 'select',
      name: 'store',
      message: 'Store',
      options: choices(storeOptions),
      initialValue: defaultStore(runtime),
    }))
  const transport =
    transportFlag ??
    (await askSelect<Transport>(ask, {
      kind: 'select',
      name: 'transport',
      message: 'Transport',
      options: choices(TRANSPORTS),
      initialValue: 'chunked',
    }))
  const agent = agentFlag ?? (await askAgent(ask))
  const install = flags.install !== undefined ? flags.install : await askInstall(ask)
  const { provider, model } = await providerAndModel(flags, tty, ask)

  return { runtime, store, transport, agent, install, provider, model }
}

async function requireText(
  flags: AddFlags,
  key: 'provider' | 'model',
  flag: string,
  message: string,
  tty: boolean,
  ask: Ask,
): Promise<string> {
  const given = clean(flags[key])
  if (given !== undefined) return given
  if (!tty) missingFlag(flag)
  return askRequiredText(ask, key, message)
}

// No default name. A non-TTY throws before ask. A TTY asks once per missing
// name. Agent add also requires provider and model; a blank answer is asked again.
export async function resolveAddNames(flags: AddFlags, tty: boolean, ask: Ask): Promise<AddNames> {
  const names: AddNames = {}
  for (const key of REQUIRED[flags.kind]) {
    const value = clean(flags[key])
    if (value !== undefined) {
      names[key] = value
      continue
    }
    if (!tty) {
      throw new BreadError(
        `Missing ${key}. Pass ${LABELS[key]} (without a TTY). There is no default.`,
        'SCAFFOLD_INVALID_NAME',
        { kind: flags.kind, key },
      )
    }
    const answered = await ask({
      kind: 'text',
      name: key,
      message: ADD_MESSAGES[flags.kind][key] ?? key,
    })
    if (typeof answered !== 'string' || answered.trim() === '') {
      throw new BreadError(
        `Missing ${key}. Pass ${LABELS[key]}. There is no default. Nothing was written.`,
        'SCAFFOLD_INVALID_NAME',
        { kind: flags.kind, key },
      )
    }
    names[key] = answered.trim()
  }
  if (flags.kind === 'agent') {
    names.provider = await requireText(flags, 'provider', '--provider', 'Catalog provider', tty, ask)
    names.model = await requireText(flags, 'model', '--model', 'Model id', tty, ask)
  }
  const description = clean(flags.description)
  if (description !== undefined) names.description = description
  return names
}
