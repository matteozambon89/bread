import { defineAgent } from '@breadai/core'
import { z } from 'zod'

export default defineAgent({
  model: {
    provider: process.env.BREAD_PROVIDER ?? 'anthropic',
    model: process.env.BREAD_MODEL ?? 'claude-opus-4-8',
    // Only meaningful for reasoning-capable Ollama models (e.g. qwen3.5) — a
    // no-op default-path change since it's namespaced under 'ollama' and only
    // ever set when BREAD_PROVIDER=ollama.
    ...(process.env.BREAD_PROVIDER === 'ollama' ? { providerOptions: { think: true } } : {}),
  },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
})
