import { BreadError } from '@breadai/core'
import { packageNameFromDir } from './names.js'

function yamlLine(label: string, value: string): string {
  const line = value.trim()
  if (/[\r\n]/.test(line)) {
    throw new BreadError(
      `${label} must be a single line so it cannot add a YAML key or close the frontmatter. Nothing was written.`,
      'SCAFFOLD_INVALID_NAME',
      { kind: label },
    )
  }
  return line
}

function jsSingleQuoted(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
  return `'${escaped}'`
}

const RANGE = '>=0.1.0 <1.0.0'

export type ListenRuntime = 'bun' | 'node'
export type StoreKind = 'sqlite' | 'memory' | 'postgres'
export type TransportKind = 'chunked' | 'sse'

const STORE_PACKAGES: Record<StoreKind, string> = {
  sqlite: '@breadai/store-sqlite',
  memory: '@breadai/store-memory',
  postgres: '@breadai/store-postgres',
}

const TRANSPORT_PACKAGES: Record<TransportKind, string> = {
  chunked: '@breadai/transport-http-chunked',
  sse: '@breadai/transport-http-sse',
}

export interface ScaffoldChoices {
  agent: string
  runtime: ListenRuntime
  store: StoreKind
  transport: TransportKind
}

function sorted(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function dependencySet(choices: ScaffoldChoices): Record<string, string> {
  const deps: Record<string, string> = {
    '@breadai/core': RANGE,
    '@breadai/provider-llm': RANGE,
    [STORE_PACKAGES[choices.store]]: RANGE,
    [TRANSPORT_PACKAGES[choices.transport]]: RANGE,
    zod: '^4.4.3',
  }
  if (choices.runtime === 'node') deps['@breadai/runtime-node'] = RANGE
  return sorted(deps)
}

export function packageJson(dir: string, choices: ScaffoldChoices): string {
  const manifest: {
    name: string
    type: 'module'
    scripts: { dev: string; build: string; start: string }
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    engines?: { node: string }
  } = {
    name: packageNameFromDir(dir),
    type: 'module',
    scripts: {
      dev: 'bread dev',
      build: 'bread build',
      start: 'bread start',
    },
    dependencies: dependencySet(choices),
    devDependencies: {
      '@breadai/cli': RANGE,
    },
  }
  if (choices.runtime === 'node') manifest.engines = { node: '>=22.18' }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function breadConfig(choices: ScaffoldChoices): string {
  const storeCall = choices.store === 'sqlite' ? "store({ path: './bread.db' })" : 'store()'
  return `import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '${STORE_PACKAGES[choices.store]}'
import { transport } from '${TRANSPORT_PACKAGES[choices.transport]}'

export default defineConfig({
  entrypoints: ['${choices.agent}'],
  server: { runtime: '${choices.runtime}' },
  store: ${storeCall},
  transport: transport(),
  providers: providerLlm,
})
`
}

export function agentSource(provider: string, model: string): string {
  return `import { defineAgent } from '@breadai/core'
import { z } from 'zod'

export default defineAgent({
  model: {
    provider: ${JSON.stringify(provider)},
    model: ${JSON.stringify(model)},
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
})
`
}

export const PROMPT_MD = 'You are a helpful assistant.\n'

export const GITIGNORE = `node_modules
.env
bread.db
bread.db-shm
bread.db-wal
`

export function toolSource(name: string): string {
  return `import { defineTool } from '@breadai/core'
import { z } from 'zod'

export default defineTool({
  name: '${name}',
  description: 'placeholder',
  schema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute() {
    return { ok: true }
  },
})
`
}

export function humanToolSource(name: string): string {
  return `import { defineHumanTool } from '@breadai/core'
import { z } from 'zod'

export default defineHumanTool('${name}', z.object({ note: z.string() }))
`
}

export function skillSource(id: string, description?: string): string {
  const name = yamlLine('Skill name', id.replaceAll('_', ' '))
  const summary = yamlLine(
    'Skill description',
    description === undefined || description.trim() === '' ? `Instructions for ${id}` : description,
  )
  return `---
name: ${name}
description: ${summary}
---

Follow these instructions.
`
}

export function evalSource(agent: string): string {
  return `import { defineEval } from '@breadai/core'

export default defineEval({
  agentId: ${jsSingleQuoted(agent)},
  type: 'functional',
  cases: [
    {
      name: 'says hello',
      input: 'hello',
      scorers: [{ type: 'contains', expected: 'hello' }],
    },
  ],
})
`
}
