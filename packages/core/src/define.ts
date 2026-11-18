import type { z } from 'zod'
import { bindStoreConfig } from './embedding.js'
import type {
  AgentConfig,
  AgentDefinition,
  BreadConfig,
  EvalConfig,
  EvalDefinition,
  HumanToolDefinition,
  ImageTaskConfig,
  ImageTaskDefinition,
  RegisteredTask,
  TaskConfig,
  TaskDefinition,
  ToolConfig,
  ToolDefinition,
} from './types.js'

export function defineConfig(config: BreadConfig): BreadConfig {
  if (config.store) bindStoreConfig(config.store, config)
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

// Not a defineTask. That path always calls generateObject.
export function defineImageTask(config: ImageTaskConfig): ImageTaskDefinition {
  return { config, _imageTaskDef: true }
}

export function isRegisteredTask(def: unknown): def is RegisteredTask {
  if (typeof def !== 'object' || def === null) return false
  const record = def as { _taskDef?: unknown; _imageTaskDef?: unknown }
  return record._taskDef === true || record._imageTaskDef === true
}

export function isImageTaskDefinition(def: RegisteredTask): def is ImageTaskDefinition {
  return '_imageTaskDef' in def && def._imageTaskDef === true
}
