export type Ask = (question: string) => Promise<unknown> | unknown

export interface InitFlags {
  runtime?: string
  store?: string
  transport?: string
  agent?: string
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

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (blank(value)) return undefined
  if (!(allowed as readonly string[]).includes(value as string)) {
    throw new Error(`Unsupported ${flag} "${value}". Supported: ${allowed.join(', ')}.`)
  }
  return value as T
}

function requireChoice<T extends string>(value: T | undefined, flag: string): T {
  if (value !== undefined) return value
  throw new Error(`Missing ${flag}. Pass ${flag} — this command does not prompt.`)
}

function requireText(value: string | undefined, flag: string): string {
  if (blank(value)) {
    throw new Error(`Missing ${flag}. Pass ${flag} — this command does not prompt.`)
  }
  return value!.trim()
}

// Flags only. A TTY missing runtime, store, transport, or agent names that flag.
// A non-TTY fills those defaults (store is memory when runtime is node).
// Provider and model have no default, with or without a TTY.
export function resolveInitChoices(flags: InitFlags, tty: boolean, ask: Ask): InitChoices {
  void ask
  const runtimeFlag = pick(flags.runtime, RUNTIMES, '--runtime')
  const storeFlag = pick(flags.store, STORES, '--store')
  const transportFlag = pick(flags.transport, TRANSPORTS, '--transport')
  const agentFlag = blank(flags.agent) ? undefined : flags.agent!.trim()

  let runtime: Runtime
  let store: Store
  let transport: Transport
  let agent: string
  if (!tty) {
    runtime = runtimeFlag ?? 'bun'
    store = storeFlag ?? (runtime === 'node' ? 'memory' : 'sqlite')
    transport = transportFlag ?? 'chunked'
    agent = agentFlag ?? 'assistant'
  } else {
    runtime = requireChoice(runtimeFlag, '--runtime')
    store = requireChoice(storeFlag, '--store')
    transport = requireChoice(transportFlag, '--transport')
    agent = requireChoice(agentFlag, '--agent')
  }

  return {
    runtime,
    store,
    transport,
    agent,
    install: flags.install !== false,
    provider: requireText(flags.provider, '--provider'),
    model: requireText(flags.model, '--model'),
  }
}

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

// Add commands have no default id. A missing name throws and never calls ask.
// Agent add also requires --provider and --model. Tool, skill, and eval do not.
export function resolveAddNames(flags: AddFlags, tty: boolean, ask: Ask): AddNames {
  void ask
  const names: AddNames = {}
  for (const key of REQUIRED[flags.kind]) {
    const value = flags[key]
    if (value === undefined || value.trim() === '') {
      const where = tty ? 'on a TTY' : 'without a TTY'
      throw new Error(`Missing ${key}. Pass ${LABELS[key]} (${where}). There is no default.`)
    }
    names[key] = value
  }
  if (flags.kind === 'agent') {
    names.provider = requireText(flags.provider, '--provider')
    names.model = requireText(flags.model, '--model')
  }
  if (flags.description !== undefined && flags.description.trim() !== '') names.description = flags.description
  return names
}
