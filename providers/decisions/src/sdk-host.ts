import { BreadError } from '@breadai/core'
import type { DecisionClient } from '@breadai/core'
import { APIError, TypeSafeClient, type Fetch } from '@typesafe-ai/sdk'
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
        fetch: sdkFetch,
        logLevel: 'off',
      })
      try {
        // 0.7 rejects a null state. An empty string is the empty value it accepts.
        const result = await client.systemOne({
          state: asState(request.state) ?? '',
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

// Bun marks a body used after getReader() and releaseLock(). SDK 0.7 does that
// before text(), so the second read throws. This reader never touches the bytes.
const sdkFetch: Fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init)
  const text = () => response.text()
  const standIn = {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text,
    clone() {
      return standIn
    },
    body: {
      getReader() {
        return {
          read: async () => ({ done: true as const, value: undefined }),
          releaseLock() {},
          cancel: async () => {},
        }
      },
    },
  }
  return standIn as unknown as Response
}
