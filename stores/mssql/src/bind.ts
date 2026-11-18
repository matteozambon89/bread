import { BreadError, type Principal } from '@breadai/core'

const TAG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const TAG_VALUE_MAX = 256
const QUERY_MAX = 1024

const LOOP_STATUS = new Set(['running', 'completed', 'exhausted', 'failed'])
const TASK_STATUS = new Set(['running', 'completed', 'failed'])
const ROLES = new Set(['user', 'assistant', 'tool'])

export function requireId(value: unknown, max = 450): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new BreadError('Id is invalid.', 'INVALID_INPUT', {})
  }
  return value
}

export function requireBody(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new BreadError('Text is invalid.', 'INVALID_INPUT', {})
  }
  return value
}

export function optionalText(value: unknown, max: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || value.length > max) {
    throw new BreadError('Text is invalid.', 'INVALID_INPUT', {})
  }
  return value
}

export function requireQuery(value: unknown): string {
  return requireBody(value, QUERY_MAX)
}

export function requireRole(value: unknown): 'user' | 'assistant' | 'tool' {
  if (typeof value === 'string' && ROLES.has(value)) return value as 'user' | 'assistant' | 'tool'
  throw new BreadError('Text is invalid.', 'INVALID_INPUT', {})
}

export function requireLoopStatus(value: unknown): 'running' | 'completed' | 'exhausted' | 'failed' {
  if (typeof value === 'string' && LOOP_STATUS.has(value)) {
    return value as 'running' | 'completed' | 'exhausted' | 'failed'
  }
  throw new BreadError('Text is invalid.', 'INVALID_INPUT', {})
}

export function requireTaskStatus(value: unknown): 'running' | 'completed' | 'failed' {
  if (typeof value === 'string' && TASK_STATUS.has(value)) return value as 'running' | 'completed' | 'failed'
  throw new BreadError('Text is invalid.', 'INVALID_INPUT', {})
}

export function requireClock(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BreadError('Timestamp is invalid.', 'INVALID_INPUT', {})
  }
  return value
}

export function optionalClock(value: unknown): number | null {
  if (value == null) return null
  return requireClock(value)
}

export function assertTags(tags: Record<string, string> | undefined): Record<string, string> {
  if (tags === undefined) return {}
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new BreadError('Tag key is not allowed.', 'INVALID_TAG', {})
  }
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    if (!TAG_KEY.test(key) || typeof value !== 'string' || value.length > TAG_VALUE_MAX) {
      throw new BreadError('Tag key is not allowed.', 'INVALID_TAG', {})
    }
    clean[key] = value
  }
  return clean
}

export function assertPrincipal(principal: Principal): { iss: string; sub: string } {
  if (principal === null || typeof principal !== 'object') {
    throw new BreadError('Principal is invalid.', 'INVALID_PRINCIPAL', {})
  }
  const { iss, sub } = principal
  if (
    typeof iss !== 'string' ||
    typeof sub !== 'string' ||
    iss.length === 0 ||
    sub.length === 0 ||
    iss.length > 256 ||
    sub.length > 256
  ) {
    throw new BreadError('Principal is invalid.', 'INVALID_PRINCIPAL', {})
  }
  return { iss, sub }
}

export function boundLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new BreadError('Limit is invalid.', 'INVALID_LIMIT', {})
  }
  return value
}

export function likeContains(query: string): string {
  let escaped = ''
  for (const char of query) {
    if (char === '\\' || char === '%' || char === '_' || char === '[') escaped += `\\${char}`
    else escaped += char
  }
  return `%${escaped}%`
}
