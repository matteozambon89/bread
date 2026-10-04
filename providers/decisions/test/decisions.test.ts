import { afterEach, describe, expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import type { DecisionClient, DecisionHostQuestion } from '@breadai/core'
import { providerDecisions } from '@breadai/provider-decisions'

const ENV_NAMES = [
  'TYPESAFE_API_KEY',
  'TYPESAFE_BASE_URL',
  'KEV_API_KEY',
  'KEV_BASE_URL',
  'LIQUID_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_AUTH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'PERPLEXITY_API_KEY',
] as const

const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
const originalFetch = globalThis.fetch

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  globalThis.fetch = originalFetch
})

interface Hit {
  url: string
  authorization: string | null
  body: Record<string, unknown>
}

function installFetch(answer: unknown, status = 200): Hit[] {
  const hits: Hit[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    hits.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return hits
}

async function client(provider: string, model: string): Promise<DecisionClient> {
  const factory = providerDecisions[provider]
  if (!factory) throw new Error(`missing provider ${provider}`)
  return factory(model)
}

const choiceQuestion: DecisionHostQuestion = {
  type: 'choice',
  text: 'Which desk?',
  options: ['billing', 'shipping'],
}

function choiceBody() {
  return {
    model: 'jev-latest',
    answers: {
      q0: { type: 'choice', choice: 'billing', confidence: 0.91, probabilities: { billing: 0.91, shipping: 0.09 } },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

describe('providerDecisions', () => {
  test('registers exactly the eight hosts', () => {
    expect(Object.keys(providerDecisions).sort()).toEqual(
      ['cloudflare', 'decider', 'kev', 'liquid', 'ollama', 'perplexity', 'strands', 'typesafe'].sort(),
    )
  })

  test('spreading the registry does not call a host', () => {
    globalThis.fetch = (() => {
      throw new Error('fetch')
    }) as typeof fetch
    expect(() => ({ ...providerDecisions })).not.toThrow()
  })

  test('typesafe posts /v1/systemone with the key, model, and choice criteria', async () => {
    process.env.TYPESAFE_API_KEY = 'ts-key'
    delete process.env.TYPESAFE_BASE_URL
    const hits = installFetch(choiceBody())
    const result = await (await client('typesafe', 'jev-latest')).systemOne({
      state: 'TICKET-8841',
      questions: [choiceQuestion],
    })
    expect(hits[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(hits[0]!.authorization).toBe('Bearer ts-key')
    expect(hits[0]!.body.model).toBe('jev-latest')
    expect(hits[0]!.body.state).toBe('TICKET-8841')
    expect(hits[0]!.body.questions).toEqual({
      q0: {
        type: 'choice',
        instructions: 'Which desk?',
        criteria: { billing: null, shipping: null },
      },
    })
    expect(result.answers[0]).toEqual({ type: 'choice', choice: 'billing', confidence: 0.91 })
  })

  test('typesafe honors TYPESAFE_BASE_URL for OpenRouter and Vercel', async () => {
    process.env.TYPESAFE_API_KEY = 'gw-key'
    process.env.TYPESAFE_BASE_URL = 'https://openrouter.ai/api'
    const openRouter = installFetch(choiceBody())
    await (await client('typesafe', 'jev-latest')).systemOne({ state: 'x', questions: [choiceQuestion] })
    expect(openRouter[0]!.url).toBe('https://openrouter.ai/api/v1/systemone')

    process.env.TYPESAFE_BASE_URL = 'https://ai-gateway.vercel.sh/typesafe'
    const vercel = installFetch(choiceBody())
    await (await client('typesafe', 'typesafe-ai/jev')).systemOne({ state: 'x', questions: [choiceQuestion] })
    expect(vercel[0]!.url).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone')
    expect(vercel[0]!.body.model).toBe('typesafe-ai/jev')
  })

  test('throws PROVIDER_NOT_CONFIGURED before fetch when TYPESAFE_API_KEY is missing', async () => {
    delete process.env.TYPESAFE_API_KEY
    globalThis.fetch = (() => {
      throw new Error('fetch')
    }) as typeof fetch
    const err = await (await client('typesafe', 'jev-latest'))
      .systemOne({ state: 'x', questions: [choiceQuestion] })
      .catch((error: unknown) => error)
    expect(err).toBeInstanceOf(BreadError)
    expect((err as BreadError).code).toBe('PROVIDER_NOT_CONFIGURED')
    expect((err as BreadError).context).toMatchObject({ provider: 'typesafe', unset: ['TYPESAFE_API_KEY'] })
  })

  test('kev posts to 127.0.0.1:8009 with bearer local', async () => {
    delete process.env.KEV_API_KEY
    delete process.env.KEV_BASE_URL
    const hits = installFetch(choiceBody())
    await (await client('kev', 'kev-latest')).systemOne({ state: 'x', questions: [choiceQuestion] })
    expect(hits[0]!.url).toBe('http://127.0.0.1:8009/v1/systemone')
    expect(hits[0]!.authorization).toBe('Bearer local')
    expect(hits[0]!.body.model).toBe('kev-latest')
  })

  test('liquid posts to the decisions base with LIQUID_API_KEY', async () => {
    process.env.LIQUID_API_KEY = 'liq-key'
    const hits = installFetch(choiceBody())
    await (await client('liquid', 'd1:free')).systemOne({ state: 'x', questions: [choiceQuestion] })
    expect(hits[0]!.url).toBe('https://api.liquid.ai/decisions/v1/systemone')
    expect(hits[0]!.authorization).toBe('Bearer liq-key')
    expect(hits[0]!.body.model).toBe('d1:free')
  })

  test('ollama posts to localhost:11434 with bearer ollama', async () => {
    const hits = installFetch(choiceBody())
    await (await client('ollama', 'nimble')).systemOne({ state: 'x', questions: [choiceQuestion] })
    expect(hits[0]!.url).toBe('http://localhost:11434/v1/systemone')
    expect(hits[0]!.authorization).toBe('Bearer ollama')
    expect(hits[0]!.body.model).toBe('nimble')
  })

  test('decider and strands use port 8000 and ignore TYPESAFE_BASE_URL', async () => {
    process.env.TYPESAFE_BASE_URL = 'https://api.typesafe.ai'
    const deciderHits = installFetch(choiceBody())
    await (await client('decider', 'decider-2b')).systemOne({ state: 'x', questions: [choiceQuestion] })
    expect(deciderHits[0]!.url).toBe('http://127.0.0.1:8000/v1/systemone')
    expect(deciderHits[0]!.authorization).toBe('Bearer local')

    const strandsHits = installFetch(choiceBody())
    await (await client('strands', 'strands-decider-2B-hobson-v19')).systemOne({
      state: 'x',
      questions: [choiceQuestion],
    })
    expect(strandsHits[0]!.url).toBe('http://127.0.0.1:8000/v1/systemone')
    expect(strandsHits[0]!.body.model).toBe('strands-decider-2B-hobson-v19')
  })

  test('sends a score rubric of ten levels and no bucket ranges', async () => {
    process.env.TYPESAFE_API_KEY = 'ts-key'
    delete process.env.TYPESAFE_BASE_URL
    const hits = installFetch({
      answers: { q0: { type: 'score', score: 4, confidence: 0.5, probabilities: {}, legend: {} } },
    })
    const result = await (await client('typesafe', 'jev-latest')).systemOne({
      state: 'x',
      questions: [{ type: 'score', text: 'How urgent?' }],
    })
    const question = (hits[0]!.body.questions as { q0: { criteria: string[] } }).q0
    expect(question.criteria).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
    expect(JSON.stringify(hits[0]!.body)).not.toContain('min')
    expect(result.answers[0]).toEqual({ type: 'score', score: 4 })
  })

  test('maps a noul answer onto probability', async () => {
    process.env.TYPESAFE_API_KEY = 'ts-key'
    const hits = installFetch({ answers: { q0: { type: 'noul', noul: 0.25 } } })
    const result = await (await client('typesafe', 'jev-latest')).systemOne({
      state: 'x',
      questions: [{ type: 'noul', text: 'Is this billing?' }],
    })
    expect((hits[0]!.body.questions as { q0: { type: string } }).q0.type).toBe('noul')
    expect(result.answers[0]).toEqual({ type: 'noul', probability: 0.25 })
  })

  test('cloudflare posts the account run URL and a short model, not /v1/systemone', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_1'
    process.env.CLOUDFLARE_AUTH_TOKEN = 'cf-auth'
    delete process.env.CLOUDFLARE_API_TOKEN
    const hits = installFetch({
      success: true,
      result: { answers: { q0: { type: 'choice', choice: 'billing', confidence: 0.4 } } },
    })
    const result = await (await client('cloudflare', '@cf/cloudflare/clef')).systemOne({
      state: 'x',
      questions: [choiceQuestion],
    })
    expect(hits[0]!.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_1/ai/run/@cf/cloudflare/clef',
    )
    expect(hits[0]!.url).not.toContain('/v1/systemone')
    expect(hits[0]!.authorization).toBe('Bearer cf-auth')
    expect(hits[0]!.body.model).toBe('clef')
    expect(result.answers[0]).toEqual({ type: 'choice', choice: 'billing', confidence: 0.4 })
  })

  test('cloudflare selects clef-flash before clef and falls back to CLOUDFLARE_API_TOKEN', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_1'
    delete process.env.CLOUDFLARE_AUTH_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = 'cf-api'
    const hits = installFetch({ answers: { q0: { type: 'noul', noul: 0.5 } } })
    await (await client('cloudflare', '@cf/cloudflare/clef-flash')).systemOne({
      state: 'x',
      questions: [{ type: 'noul', text: 'Yes?' }],
    })
    expect(hits[0]!.url).toContain('/ai/run/@cf/cloudflare/clef-flash')
    expect(hits[0]!.body.model).toBe('clef-flash')
    expect(hits[0]!.authorization).toBe('Bearer cf-api')
  })

  test('perplexity posts /v1/decisions', async () => {
    process.env.PERPLEXITY_API_KEY = 'pplx-key'
    const hits = installFetch({ answers: { q0: { type: 'noul', noul: 0.7 } } })
    const result = await (await client('perplexity', 'pplx-decider-v1-27b')).systemOne({
      state: 'x',
      questions: [{ type: 'noul', text: 'Yes?' }],
    })
    expect(hits[0]!.url).toBe('https://api.perplexity.ai/v1/decisions')
    expect(hits[0]!.authorization).toBe('Bearer pplx-key')
    expect(hits[0]!.body.model).toBe('pplx-decider-v1-27b')
    expect(result.answers[0]).toEqual({ type: 'noul', probability: 0.7 })
  })

  test('a missing liquid or perplexity key throws before fetch', async () => {
    delete process.env.LIQUID_API_KEY
    delete process.env.PERPLEXITY_API_KEY
    globalThis.fetch = (() => {
      throw new Error('fetch')
    }) as typeof fetch
    const liquid = await (await client('liquid', 'd1:free'))
      .systemOne({ state: 'x', questions: [choiceQuestion] })
      .catch((error: unknown) => error)
    expect((liquid as BreadError).code).toBe('PROVIDER_NOT_CONFIGURED')
    const perplexity = await (await client('perplexity', 'pplx-decider-v1-27b'))
      .systemOne({ state: 'x', questions: [{ type: 'noul', text: 'Yes?' }] })
      .catch((error: unknown) => error)
    expect((perplexity as BreadError).context).toMatchObject({
      provider: 'perplexity',
      unset: ['PERPLEXITY_API_KEY'],
    })
  })

  test('throws DECISION_HOST with the HTTP status', async () => {
    process.env.PERPLEXITY_API_KEY = 'pplx-key'
    installFetch({ error: 'no' }, 401)
    const err = await (await client('perplexity', 'pplx-decider-v1-27b'))
      .systemOne({ state: 'x', questions: [{ type: 'noul', text: 'Yes?' }] })
      .catch((error: unknown) => error)
    expect((err as BreadError).code).toBe('DECISION_HOST')
    expect((err as BreadError).context).toMatchObject({ provider: 'perplexity', status: 401 })
  })
})
