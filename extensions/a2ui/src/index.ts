import { isFileOutput } from '@bread/core'
import type { BreadCrumb, BreadInstanceRef, BreadPlugin } from '@bread/core'

// A2UI (Agent-to-UI) — Google A2UI declarative UI spec v1.0-candidate
export type A2UIComponentType = 'text' | 'markdown' | 'card' | 'form' | 'progress' | 'error' | 'file'

export interface A2UISpec {
  type: A2UIComponentType
  content?: string
  fields?: Array<{ name: string; type: string; label: string; required?: boolean }>
  progress?: number
  message?: string
  metadata?: Record<string, unknown>
}

export type A2UIHandler = (spec: A2UISpec, crumb: BreadCrumb) => void

export interface A2UIOptions {
  onSpec?: A2UIHandler
}

function crumbToA2UI(crumb: BreadCrumb): A2UISpec | null {
  switch (crumb.type) {
    case 'agent:run:start':
      return { type: 'progress', progress: 0, message: `Agent ${crumb.agentId} started` }

    case 'text:delta':
      return { type: 'markdown', content: crumb.delta }

    case 'reasoning:delta':
      return { type: 'text', content: crumb.delta }

    case 'file:generated':
      return { type: 'file', metadata: { uri: crumb.uri, mimeType: crumb.mimeType, name: crumb.name } }

    case 'tool:call':
      return {
        type: 'card',
        metadata: {
          toolName: crumb.toolName,
          status: 'calling',
        },
      }

    case 'human:required':
      return {
        type: 'form',
        message: crumb.prompt ?? `Input required for ${crumb.toolName}`,
        fields: [{ name: 'response', type: 'text', label: 'Response', required: true }],
        metadata: { checkpointId: crumb.checkpointId, toolName: crumb.toolName },
      }

    case 'agent:run:end':
      return { type: 'progress', progress: 1, message: 'Done' }

    case 'agent:error':
      return { type: 'error', message: crumb.error.message }

    case 'loop:start':
      return {
        type: 'progress',
        progress: 0,
        message: `Loop started: ${crumb.pipeline.join(' → ')}`,
        metadata: { loopId: crumb.loopId, maxIterations: crumb.maxIterations },
      }

    case 'loop:iteration:start':
      return {
        type: 'progress',
        message: `Iteration ${crumb.iteration}`,
        metadata: { loopId: crumb.loopId, iteration: crumb.iteration },
      }

    case 'loop:end':
      return {
        type: 'progress',
        progress: 1,
        message: `Loop ${crumb.status} after ${crumb.iterations} iteration(s)`,
        metadata: { loopId: crumb.loopId, status: crumb.status },
      }

    case 'subagent:run:start':
      return {
        type: 'progress',
        progress: 0,
        message: `Sub-agent ${crumb.subagentId} started`,
        metadata: { parentAgentId: crumb.parentAgentId, subagentId: crumb.subagentId },
      }

    case 'subagent:run:end':
      return {
        type: 'progress',
        progress: 1,
        message: `Sub-agent ${crumb.subagentId} done`,
        metadata: { parentAgentId: crumb.parentAgentId, subagentId: crumb.subagentId, output: crumb.output },
      }

    case 'pipeline:step:start':
      return {
        type: 'progress',
        progress: 0,
        message: `Pipeline step ${crumb.stepIndex} started`,
        metadata: { pipelineId: crumb.pipelineId, stepIndex: crumb.stepIndex },
      }

    case 'pipeline:step:end':
      return {
        type: 'progress',
        progress: 1,
        message: `Pipeline step ${crumb.stepIndex} done`,
        metadata: { pipelineId: crumb.pipelineId, stepIndex: crumb.stepIndex, output: crumb.output },
      }

    case 'tool:result':
      return {
        type: 'card',
        metadata: {
          toolName: crumb.toolName,
          status: 'done',
          result: crumb.result,
          durationMs: crumb.durationMs,
        },
      }

    case 'tool:error':
      return {
        type: 'error',
        message: crumb.error.message,
        metadata: { toolName: crumb.toolName, toolCallId: crumb.toolCallId, durationMs: crumb.durationMs },
      }

    case 'human:resumed':
      return {
        type: 'progress',
        progress: 1,
        message: 'Human input received',
        metadata: { checkpointId: crumb.checkpointId, kind: crumb.kind, response: crumb.response },
      }

    case 'loop:iteration:end':
      return {
        type: 'progress',
        message: `Iteration ${crumb.iteration} done`,
        metadata: { loopId: crumb.loopId, iteration: crumb.iteration, output: crumb.output },
      }

    case 'task:start':
      return {
        type: 'progress',
        progress: 0,
        message: `Task ${crumb.taskId} started`,
        metadata: { taskRunId: crumb.taskRunId, taskId: crumb.taskId, model: crumb.model },
      }

    case 'task:end':
      return {
        type: 'progress',
        progress: 1,
        message: `Task ${crumb.taskId} ${crumb.status}`,
        metadata: {
          taskRunId: crumb.taskRunId,
          taskId: crumb.taskId,
          status: crumb.status,
          durationMs: crumb.durationMs,
          usage: crumb.usage,
          error: crumb.error,
        },
      }

    default:
      return null
  }
}

// Sits next to crumbToA2UI — the only crumb type that can produce a second spec (a
// tool-echoed file alongside the 'Done' progress spec agent:run:end already emits).
function agentOutputFileSpec(crumb: BreadCrumb): A2UISpec | null {
  if (crumb.type !== 'agent:run:end' || !isFileOutput(crumb.output)) return null
  return { type: 'file', metadata: { uri: crumb.output.uri, mimeType: crumb.output.mimeType, name: crumb.output.name } }
}

export function a2ui(opts: A2UIOptions = {}): BreadPlugin {
  return {
    name: 'a2ui',

    async init(bread: BreadInstanceRef) {
      bread.on('crumb', (crumb: BreadCrumb) => {
        const fileSpec = agentOutputFileSpec(crumb)
        if (fileSpec) opts.onSpec?.(fileSpec, crumb)
        const spec = crumbToA2UI(crumb)
        if (spec) opts.onSpec?.(spec, crumb)
      })
    },
  }
}
