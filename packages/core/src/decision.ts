import { BreadError } from './types.js'

export interface DecisionBucket {
  label: string
  min: number
  max: number
}

export type DecisionQuestion =
  | {
      type: 'choice'
      text: string
      options: string[]
      otherwise: string
      minConfidence?: number
    }
  | { type: 'score'; text: string; buckets: DecisionBucket[] }
  | { type: 'noul'; text: string; buckets: DecisionBucket[] }

// What a host actually receives. Routing (otherwise, minConfidence, buckets)
// stays in core — ranges exist only in the buckets.
export type DecisionHostQuestion =
  | { type: 'choice'; text: string; options: string[] }
  | { type: 'score'; text: string }
  | { type: 'noul'; text: string }

export type DecisionHostAnswer =
  | { type: 'choice'; choice: string; confidence?: number }
  | { type: 'score'; score?: number }
  | { type: 'noul'; probability?: number }

export interface DecisionClient {
  systemOne(request: {
    state: unknown
    questions: DecisionHostQuestion[]
  }): Promise<{ answers: DecisionHostAnswer[] }>
}

export type DecisionRegistry = Record<
  string,
  (modelId: string) => DecisionClient | Promise<DecisionClient>
>

export function toHostQuestion(question: DecisionQuestion): DecisionHostQuestion {
  if (question.type === 'choice') {
    return { type: 'choice', text: question.text, options: question.options }
  }
  return { type: question.type, text: question.text }
}

export async function resolveDecisionClient(
  registry: DecisionRegistry | undefined,
  provider: string,
  model: string,
): Promise<DecisionClient> {
  if (registry === undefined) {
    throw new BreadError(
      'No decision registry is configured. Set `decisions` in bread.config.ts ' +
        '(see @breadai/provider-decisions).',
      'DECISION_NOT_CONFIGURED',
    )
  }
  const factory = registry[provider]
  if (!factory) {
    const known = Object.keys(registry)
    throw new BreadError(
      `Unknown decision provider: "${provider}". ` +
        (known.length
          ? `Registered: ${known.join(', ')}. `
          : 'No decision providers are registered. ') +
        'Set `decisions` in bread.config.ts (see @breadai/provider-decisions).',
      'UNKNOWN_DECISION_PROVIDER',
      { provider, registered: known },
    )
  }
  return factory(model)
}

export function decisionLabel(
  question: DecisionQuestion,
  answers: readonly DecisionHostAnswer[] | undefined,
): { label: string; answer: DecisionHostAnswer } {
  const answer = answers?.[0]
  if (!answer) {
    throw new BreadError(
      `Decision host returned no ${question.type} answer.`,
      'DECISION_ANSWER',
      { expected: question.type },
    )
  }
  if (question.type === 'choice') {
    if (answer.type !== 'choice') throw answerTypeError('choice', answer)
    return { label: choiceLabel(question, answer), answer }
  }
  if (question.type === 'score') {
    if (answer.type !== 'score') throw answerTypeError('score', answer)
    return { label: bucketLabel('score', question.buckets, answer.score), answer }
  }
  if (answer.type !== 'noul') throw answerTypeError('noul', answer)
  return { label: bucketLabel('noul', question.buckets, answer.probability), answer }
}

function choiceLabel(
  question: Extract<DecisionQuestion, { type: 'choice' }>,
  answer: Extract<DecisionHostAnswer, { type: 'choice' }>,
): string {
  if (!question.options.includes(answer.choice)) return question.otherwise
  if (question.minConfidence === undefined) return answer.choice
  const confidence = answer.confidence
  // Missing or non-finite confidence fails closed once a floor is set.
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return question.otherwise
  if (confidence < question.minConfidence) return question.otherwise
  return answer.choice
}

function bucketLabel(kind: 'score' | 'noul', buckets: readonly DecisionBucket[], value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BreadError(
      `Decision ${kind} answer is missing a finite number.`,
      'DECISION_ANSWER',
      { type: kind },
    )
  }
  const matches = buckets.filter((bucket) => value >= bucket.min && value <= bucket.max)
  if (matches.length !== 1) {
    throw new BreadError(
      `Decision ${kind} value ${value} matched ${matches.length} buckets; exactly one is required.`,
      'DECISION_BUCKET',
      { type: kind, value, matches: matches.map((bucket) => bucket.label) },
    )
  }
  return matches[0]!.label
}

function answerTypeError(expected: DecisionQuestion['type'], answer: DecisionHostAnswer): BreadError {
  return new BreadError(
    `Decision host returned a ${answer.type} answer; expected ${expected}.`,
    'DECISION_ANSWER',
    { expected, received: answer.type },
  )
}
