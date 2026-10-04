import { BreadError } from '@breadai/core'
import type { DecisionClient } from '@breadai/core'
import { APIError, TypeSafeClient } from '@typesafe-ai/sdk'
import { asState, normalizeAnswers, wireQuestions } from './wire.js'

export interface SdkHostOptions {
  provider: string
  modelId: string
  baseURL: string
  apiKey: string
}

export function sdkClient(options: SdkHostOptions): DecisionClient {
  return {
    async systemOne(request) {
      // A client cached across calls would keep the first key and the fetch
      // captured at construction. Tests swap both between calls, and a Modal
      // or gateway key can change without rebuilding the registry.
      const client = new TypeSafeClient({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        fetch: globalThis.fetch,
        logLevel: 'off',
      })
      try {
        const result = await client.systemOne({
          state: asState(request.state),
          questions: wireQuestions(request.questions),
          model: options.modelId,
        })
        return { answers: normalizeAnswers(request.questions, result.answers) }
      } catch (err) {
        if (!(err instanceof APIError)) throw err
        throw new BreadError(
          `Decision host "${options.provider}" returned HTTP ${err.status}.`,
          'DECISION_HOST',
          { provider: options.provider, status: err.status },
          err,
        )
      }
    },
  }
}
