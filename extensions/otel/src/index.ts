import { context, trace, type Span, type Tracer } from '@opentelemetry/api'
import { isFileOutput } from '@bread/core'
import type { BreadCrumb, BreadInstanceRef, BreadPlugin } from '@bread/core'

export interface OtelOptions {
  serviceName?: string
  tracer?: Tracer
}

export function otel(opts: OtelOptions = {}): BreadPlugin {
  const tracer = opts.tracer ?? trace.getTracer(opts.serviceName ?? 'bread')
  const runSpans = new Map<string, Span>()
  const toolSpans = new Map<string, Span>()
  const stepSpans = new Map<string, Span>()
  const humanSpans = new Map<string, Span>()
  const subagentSpans = new Map<string, Span>()
  const loopSpans = new Map<string, Span>()
  // Secondary index over spans owned by runSpans, so a mediated subagent:run:*
  // crumb (which carries parentAgentId, not a parent runId) can still find its
  // parent's span. Best-effort: last-write-wins if the same agentId has two
  // concurrently open runs. Never drained directly in close() — runSpans owns
  // the span lifecycle; this just tracks "current" pointers into it.
  const runSpansByAgentId = new Map<string, Span>()

  // Tool/step spans open as children of their run span when it exists.
  const childOf = (parent: Span | undefined) =>
    parent ? trace.setSpan(context.active(), parent) : context.active()

  return {
    name: 'otel',

    async init(_bread: BreadInstanceRef) {
      _bread.on('crumb', (crumb: BreadCrumb) => {
        if (crumb.type === 'agent:run:start') {
          const span = tracer.startSpan(`agent.run`, {
            attributes: {
              'bread.agent_id': crumb.agentId,
              'bread.run_id': crumb.runId,
              'bread.session_id': crumb.sessionId,
            },
          })
          runSpans.set(crumb.runId, span)
          runSpansByAgentId.set(crumb.agentId, span)
        } else if (crumb.type === 'agent:run:end') {
          const span = runSpans.get(crumb.runId)
          if (span) {
            span.setAttribute('bread.duration_ms', crumb.durationMs)
            if (isFileOutput(crumb.output)) span.setAttribute('bread.output_file_uri', crumb.output.uri)
            span.end()
            runSpans.delete(crumb.runId)
            if (runSpansByAgentId.get(crumb.agentId) === span) runSpansByAgentId.delete(crumb.agentId)
          }
        } else if (crumb.type === 'file:generated') {
          const span = tracer.startSpan(
            `file.generated`,
            { attributes: { 'bread.file_uri': crumb.uri, 'bread.file_mime_type': crumb.mimeType } },
            childOf(runSpans.get(crumb.runId)),
          )
          span.end()
        } else if (crumb.type === 'tool:call') {
          const span = tracer.startSpan(
            `tool.call.${crumb.toolName}`,
            {
              attributes: {
                'bread.tool_name': crumb.toolName,
                'bread.tool_call_id': crumb.toolCallId,
              },
            },
            childOf(runSpans.get(crumb.runId)),
          )
          toolSpans.set(crumb.toolCallId, span)
        } else if (crumb.type === 'tool:result') {
          const span = toolSpans.get(crumb.toolCallId)
          if (span) {
            span.setAttribute('bread.duration_ms', crumb.durationMs)
            span.end()
            toolSpans.delete(crumb.toolCallId)
          }
        } else if (crumb.type === 'tool:error') {
          const span = toolSpans.get(crumb.toolCallId)
          if (span) {
            span.recordException(crumb.error)
            span.end()
            toolSpans.delete(crumb.toolCallId)
          }
        } else if (crumb.type === 'pipeline:step:start') {
          const span = tracer.startSpan(`pipeline.step.${crumb.stepIndex}`, {
            attributes: {
              'bread.pipeline_id': crumb.pipelineId,
              'bread.step_index': crumb.stepIndex,
              'bread.agent_id': crumb.agentId,
            },
          })
          stepSpans.set(crumb.runId, span)
        } else if (crumb.type === 'pipeline:step:end') {
          const span = stepSpans.get(crumb.runId)
          if (span) {
            span.end()
            stepSpans.delete(crumb.runId)
          }
        } else if (crumb.type === 'human:required') {
          const span = tracer.startSpan(
            `human.wait`,
            {
              attributes: {
                'bread.checkpoint_id': crumb.checkpointId,
                'bread.tool_name': crumb.toolName,
                'bread.kind': crumb.kind,
              },
            },
            childOf(runSpans.get(crumb.runId)),
          )
          humanSpans.set(crumb.checkpointId, span)
        } else if (crumb.type === 'human:resumed') {
          const span = humanSpans.get(crumb.checkpointId)
          if (span) {
            span.end()
            humanSpans.delete(crumb.checkpointId)
          }
        } else if (crumb.type === 'subagent:run:start') {
          const span = tracer.startSpan(
            `subagent.run`,
            {
              attributes: {
                'bread.agent_id': crumb.subagentId,
                'bread.parent_agent_id': crumb.parentAgentId,
                'bread.run_id': crumb.runId,
              },
            },
            childOf(runSpansByAgentId.get(crumb.parentAgentId)),
          )
          subagentSpans.set(crumb.runId, span)
        } else if (crumb.type === 'subagent:run:end') {
          const span = subagentSpans.get(crumb.runId)
          if (span) {
            span.end()
            subagentSpans.delete(crumb.runId)
          }
        } else if (crumb.type === 'loop:start') {
          const span = tracer.startSpan(
            `loop.run`,
            {
              attributes: {
                'bread.loop_id': crumb.loopId,
                'bread.pipeline': crumb.pipeline,
                'bread.max_iterations': crumb.maxIterations,
              },
            },
            childOf(runSpans.get(crumb.runId)),
          )
          loopSpans.set(crumb.loopId, span)
        } else if (crumb.type === 'loop:iteration:start') {
          const span = tracer.startSpan(
            `loop.iteration.${crumb.iteration}`,
            {
              attributes: {
                'bread.loop_id': crumb.loopId,
                'bread.iteration': crumb.iteration,
              },
            },
            childOf(loopSpans.get(crumb.loopId)),
          )
          loopSpans.set(`${crumb.loopId}:${crumb.iteration}`, span)
        } else if (crumb.type === 'loop:iteration:end') {
          const key = `${crumb.loopId}:${crumb.iteration}`
          const span = loopSpans.get(key)
          if (span) {
            span.end()
            loopSpans.delete(key)
          }
        } else if (crumb.type === 'loop:end') {
          // A failed, unrecovered iteration leaves its loop:iteration:start
          // unmatched (finalizeIteration never ran) — active.iteration only
          // advances on success, so the dangling span, if any, is always at
          // crumb.iterations + 1.
          const danglingKey = `${crumb.loopId}:${crumb.iterations + 1}`
          const dangling = loopSpans.get(danglingKey)
          if (dangling) {
            dangling.end()
            loopSpans.delete(danglingKey)
          }
          const span = loopSpans.get(crumb.loopId)
          if (span) {
            span.setAttribute('bread.status', crumb.status)
            span.setAttribute('bread.iterations', crumb.iterations)
            span.end()
            loopSpans.delete(crumb.loopId)
          }
        } else if (crumb.type === 'agent:error') {
          const span = crumb.runId ? runSpans.get(crumb.runId) : undefined
          if (span) {
            span.recordException(crumb.error)
            span.end()
            crumb.runId && runSpans.delete(crumb.runId)
          }
        }
      })
    },

    async close() {
      for (const spans of [runSpans, toolSpans, stepSpans, humanSpans, subagentSpans, loopSpans]) {
        for (const span of spans.values()) span.end()
        spans.clear()
      }
    },
  }
}
