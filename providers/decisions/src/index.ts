import { BreadError, type DecisionClient, type DecisionRegistry } from '@breadai/core'
import { envValue, requireEnv } from './env.js'
import { cloudflareBodyModel, httpClient } from './http-host.js'
import { sdkClient } from './sdk-host.js'

const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai'
const KEV_DEFAULT_BASE_URL = 'http://127.0.0.1:8009'
const LIQUID_BASE_URL = 'https://api.liquid.ai/decisions'
const LOCAL_8000 = 'http://127.0.0.1:8000'
const OLLAMA_BASE_URL = 'http://localhost:11434'

function lazy(load: () => DecisionClient): DecisionClient {
  return {
    async systemOne(request) {
      return load().systemOne(request)
    },
  }
}

// Eight System One hosts. OpenRouter and Vercel are `TYPESAFE_BASE_URL` on
// `typesafe`, not extra keys. Together's native API is not a host.
export const providerDecisions: DecisionRegistry = {
  typesafe: (modelId) =>
    lazy(() => {
      const env = requireEnv('typesafe', ['TYPESAFE_API_KEY'])
      return sdkClient({
        provider: 'typesafe',
        modelId,
        apiKey: env.TYPESAFE_API_KEY!,
        baseURL: envValue('TYPESAFE_BASE_URL') ?? TYPESAFE_DEFAULT_BASE_URL,
      })
    }),
  kev: (modelId) =>
    lazy(() =>
      sdkClient({
        provider: 'kev',
        modelId,
        apiKey: envValue('KEV_API_KEY') ?? 'local',
        baseURL: envValue('KEV_BASE_URL') ?? KEV_DEFAULT_BASE_URL,
      }),
    ),
  liquid: (modelId) =>
    lazy(() => {
      const env = requireEnv('liquid', ['LIQUID_API_KEY'])
      return sdkClient({
        provider: 'liquid',
        modelId,
        apiKey: env.LIQUID_API_KEY!,
        baseURL: LIQUID_BASE_URL,
      })
    }),
  decider: (modelId) =>
    lazy(() =>
      sdkClient({
        provider: 'decider',
        modelId,
        apiKey: 'local',
        baseURL: LOCAL_8000,
      }),
    ),
  ollama: (modelId) =>
    lazy(() =>
      sdkClient({
        provider: 'ollama',
        modelId,
        apiKey: 'ollama',
        baseURL: OLLAMA_BASE_URL,
      }),
    ),
  strands: (modelId) =>
    lazy(() =>
      sdkClient({
        provider: 'strands',
        modelId,
        apiKey: 'local',
        baseURL: LOCAL_8000,
      }),
    ),
  cloudflare: (modelId) =>
    lazy(() => {
      const accountId = envValue('CLOUDFLARE_ACCOUNT_ID')
      const apiKey = envValue('CLOUDFLARE_AUTH_TOKEN') ?? envValue('CLOUDFLARE_API_TOKEN')
      const unset = [
        ...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID']),
        ...(apiKey ? [] : ['CLOUDFLARE_AUTH_TOKEN', 'CLOUDFLARE_API_TOKEN']),
      ]
      if (!accountId || !apiKey) {
        throw new BreadError(
          `Decision provider "cloudflare" is not configured. Missing env vars: ${unset.join(', ')}`,
          'PROVIDER_NOT_CONFIGURED',
          { provider: 'cloudflare', unset },
        )
      }
      return httpClient({
        provider: 'cloudflare',
        modelId,
        apiKey,
        url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`,
        bodyModel: cloudflareBodyModel(modelId),
      })
    }),
  perplexity: (modelId) =>
    lazy(() => {
      const env = requireEnv('perplexity', ['PERPLEXITY_API_KEY'])
      return httpClient({
        provider: 'perplexity',
        modelId,
        apiKey: env.PERPLEXITY_API_KEY!,
        url: 'https://api.perplexity.ai/v1/decisions',
      })
    }),
}
