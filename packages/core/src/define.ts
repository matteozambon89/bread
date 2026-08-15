import type { z } from 'zod'
import type {
  AgentConfig,
  AgentDefinition,
  BreadConfig,
  EvalConfig,
  EvalDefinition,
  HumanToolDefinition,
  TaskConfig,
  TaskDefinition,
  ToolConfig,
  ToolDefinition,
} from './types.js'

export function defineConfig(config: BreadConfig): BreadConfig {
  return config
}

export function defineAgent<I, O>(config: AgentConfig<I, O>): AgentDefinition<I, O> {
  return { config, _agentDef: true }
}

export function defineTool<A, R>(config: ToolConfig<A, R>): ToolDefinition<A, R> {
  return config
}

export function defineHumanTool<S extends z.ZodType>(
  name: string,
  schema: S,
): HumanToolDefinition<S> {
  return { name, schema, _human: true }
}

export function defineEval(config: EvalConfig): EvalDefinition {
  return { config, _evalDef: true }
}

export function defineTask<Args, Out>(config: TaskConfig<Args, Out>): TaskDefinition<Args, Out> {
  return { config, _taskDef: true }
}
