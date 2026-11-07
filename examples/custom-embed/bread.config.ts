import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-postgres'
import { transport } from '@breadai/transport-http-chunked'

let calls = 0

export function customEmbedCalls(): number {
  return calls
}

function vectorFor(text: string): number[] {
  const values = [0, 0, 0, 0]
  for (let index = 0; index < text.length; index++) {
    const current = values[index % 4] ?? 0
    values[index % 4] = (current + text.charCodeAt(index)) % 997
  }
  return values
}

// Same text, same vector. The throw keeps a write from reaching SQL;
// return `vector` to store it. This does not read config.embeddings.
async function embed(text: string): Promise<number[]> {
  calls += 1
  const vector = vectorFor(text)
  throw new Error(`stop before sql ${vector.join(',')}`)
}

export default defineConfig({
  entrypoints: ['echo'],
  store: store({ embed }),
  transport: transport(),
  providers: providerLlm,
})
