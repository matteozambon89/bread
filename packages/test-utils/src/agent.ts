import { z } from 'zod'
import type { AgentConfig, AgentDefinition, ToolDefinition } from '@breadai/core'
import { MOCK_PROVIDER } from './mock-plugin.js'

// Loosely typed: matches the runner's `_humanTools` shape without re-importing
// the generic HumanToolDefinition signature.
type HumanTool = { name: string; schema: unknown; _human: true }

interface TestAgentOpts {
  /** Model id passed to the mock provider. Defaults to 'default'. */
  model?: string
  systemPrompt?: string
  /** Regular tools — attached to the loader-injected `_tools` field. */
  tools?: ToolDefinition[]
  /** HITL tools — attached to the loader-injected `_humanTools` field. */
  humanTools?: HumanTool[]
  /** Overrides merged into the agent config (e.g. output, loop, steps). */
  config?: Partial<AgentConfig<unknown, unknown>>
}

/**
 * Builds a valid `AgentDefinition` wired to the `mock` provider, terse enough for
 * runner-level tests. Mirrors what the CLI loader produces by attaching the
 * private `_tools` / `_systemPrompt` fields the runner reads (see CLAUDE.md).
 */
export function defineTestAgent(opts: TestAgentOpts = {}): AgentDefinition<unknown, unknown> {
  const config = {
    model: { provider: MOCK_PROVIDER, model: opts.model ?? 'default' },
    inputSchema: z.unknown(),
    // Permissive rather than z.string(): a test overriding only output.format (e.g. to 'json')
    // without also overriding outputSchema still needs this to accept whatever shape the mock
    // model returns. The 'text' default below never actually reads outputSchema at runtime
    // (runner.ts's text/markdown path doesn't apply it), so this is safe for that case too.
    outputSchema: z.unknown(),
    output: { format: 'text' },
    ...opts.config,
  } as unknown as AgentConfig<unknown, unknown>
  // Loader-injected privates the runner reads off `config`.
  const priv = config as unknown as Record<string, unknown>
  priv._tools = opts.tools ?? []
  if (opts.humanTools) priv._humanTools = opts.humanTools
  if (opts.systemPrompt !== undefined) priv._systemPrompt = opts.systemPrompt
  return { config, _agentDef: true }
}
