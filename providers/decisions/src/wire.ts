import { BreadError } from '@breadai/core'
import type { DecisionHostAnswer, DecisionHostQuestion } from '@breadai/core'

// Fixed 0–9 rubric. Several hosts cap a score question at 10 levels, and the
// number they return is an index on that rubric. Bread ranges stay in the
// step's buckets; they are not sent to the host.
export const SCORE_LEVELS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

type JsonState = string | { [key: string]: JsonState } | JsonState[] | null

export function asState(value: unknown): JsonState {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value)) as JsonState
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// Same objects the SDK's choice/score/noul helpers build. A single interface
// with a union `type` is not a `Question`, so systemOne would need a cast.
export type WiredQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, null> }
  | { type: 'score'; instructions: string; criteria: readonly [string, string, ...string[]] }
  | { type: 'noul'; instructions: string }

export function wireQuestions(questions: readonly DecisionHostQuestion[]): Record<string, WiredQuestion> {
  const named: Record<string, WiredQuestion> = {}
  questions.forEach((question, index) => {
    if (question.type === 'choice') {
      const criteria: Record<string, null> = {}
      for (const option of question.options) criteria[option] = null
      named[`q${index}`] = { type: 'choice', instructions: question.text, criteria }
      return
    }
    if (question.type === 'score') {
      named[`q${index}`] = { type: 'score', instructions: question.text, criteria: SCORE_LEVELS }
      return
    }
    named[`q${index}`] = { type: 'noul', instructions: question.text }
  })
  return named
}

export function normalizeAnswers(
  questions: readonly DecisionHostQuestion[],
  answers: unknown,
): DecisionHostAnswer[] {
  if (!answers || typeof answers !== 'object') {
    throw new BreadError('Decision host returned no answers.', 'DECISION_ANSWER', {})
  }
  const record = answers as Record<string, unknown>
  return questions.map((question, index) => normalizeOne(question, record[`q${index}`]))
}

function normalizeOne(question: DecisionHostQuestion, raw: unknown): DecisionHostAnswer {
  if (!raw || typeof raw !== 'object') {
    throw new BreadError(`Decision host returned no ${question.type} answer.`, 'DECISION_ANSWER', {
      expected: question.type,
    })
  }
  const body = raw as Record<string, unknown>
  if (body.type === 'choice' && typeof body.choice === 'string') {
    return typeof body.confidence === 'number'
      ? { type: 'choice', choice: body.choice, confidence: body.confidence }
      : { type: 'choice', choice: body.choice }
  }
  if (body.type === 'score' && typeof body.score === 'number' && Number.isFinite(body.score)) {
    return { type: 'score', score: body.score }
  }
  if (body.type === 'noul') {
    const probability = typeof body.noul === 'number' ? body.noul : body.probability
    if (typeof probability === 'number' && Number.isFinite(probability)) {
      return { type: 'noul', probability }
    }
  }
  throw new BreadError(
    `Decision host returned an unreadable ${question.type} answer.`,
    'DECISION_ANSWER',
    { expected: question.type, received: body.type },
  )
}
