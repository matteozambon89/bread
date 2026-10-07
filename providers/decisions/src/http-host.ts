import { BreadError } from '@breadai/core'
import type { DecisionClient } from '@breadai/core'
import { asState, normalizeAnswers, wireQuestions } from './wire.js'

export interface HttpHostOptions {
  provider: string
  modelId: string
  url: string
  apiKey: string
  // Cloudflare's run URL already names the model. The JSON `model` field is the
  // short selector (`clef` / `clef-flash`), which is not the path segment.
  bodyModel?: string
}

export function httpClient(options: HttpHostOptions): DecisionClient {
  return {
    async systemOne(request) {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.bodyModel ?? options.modelId,
          state: asState(request.state),
          questions: wireQuestions(request.questions),
        }),
      })
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new BreadError(
          `Decision host "${options.provider}" returned HTTP ${response.status}.`,
          'DECISION_HOST',
          { provider: options.provider, status: response.status },
        )
      }
      return { answers: normalizeAnswers(request.questions, answersOf(body)) }
    },
  }
}

function answersOf(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined
  const record = body as { answers?: unknown; result?: { answers?: unknown } }
  return record.result?.answers ?? record.answers
}

// `@cf/cloudflare/clef-flash`.endsWith('clef') is true, so flash has to win.
export function cloudflareBodyModel(modelId: string): string {
  if (modelId === 'clef-flash' || modelId.endsWith('/clef-flash')) return 'clef-flash'
  if (modelId === 'clef' || modelId.endsWith('/clef')) return 'clef'
  return modelId
}
