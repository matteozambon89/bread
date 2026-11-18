import { BreadError, type Principal } from '@breadai/core'

export const LIMIT_MAX = 100

// Keys are data for JSON_CONTAINS. They are never interpolated into a path.
const TAG_KEY = /^[a-z][a-z0-9_]{0,31}$/

export function asString(value: unknown, code = 'INVALID_ID'): string {
  if (typeof value !== 'string') throw new BreadError('A string is required.', code, {})
  return value
}

export function principalKeys(principal: Principal): { iss: string; sub: string } {
  if (typeof principal?.iss !== 'string' || typeof principal?.sub !== 'string') {
    throw new BreadError('Principal iss and sub must be strings.', 'INVALID_PRINCIPAL', {})
  }
  return { iss: principal.iss, sub: principal.sub }
}

export function principalJson(principal: Principal): string {
  const keys = principalKeys(principal)
  const stored: { iss: string; sub: string; tenant?: string; roles?: string[] } = keys
  if (principal.tenant !== undefined) {
    if (typeof principal.tenant !== 'string') {
      throw new BreadError('Principal tenant must be a string.', 'INVALID_PRINCIPAL', {})
    }
    stored.tenant = principal.tenant
  }
  if (principal.roles !== undefined) {
    if (!Array.isArray(principal.roles) || principal.roles.some((role) => typeof role !== 'string')) {
      throw new BreadError('Principal roles must be strings.', 'INVALID_PRINCIPAL', {})
    }
    stored.roles = principal.roles
  }
  return JSON.stringify(stored)
}

export function tagsJson(tags: Record<string, string> | undefined): string {
  const source = tags ?? {}
  const clean: Record<string, string> = {}
  for (const key of Object.keys(source)) {
    if (!TAG_KEY.test(key)) throw new BreadError('Tag key is invalid.', 'INVALID_TAG', {})
    const value = source[key]
    if (typeof value !== 'string') throw new BreadError('Tag value is invalid.', 'INVALID_TAG', {})
    clean[key] = value
  }
  return JSON.stringify(clean)
}

export function jsonText(value: unknown): string {
  const text = JSON.stringify(value === undefined ? null : value)
  if (typeof text !== 'string') throw new BreadError('Value is not JSON.', 'INVALID_JSON', {})
  return text
}

export function limitParam(value: number | undefined, fallback: number): number {
  const chosen = value === undefined ? fallback : value
  if (typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen < 1 || chosen > LIMIT_MAX) {
    throw new BreadError('Limit is invalid.', 'INVALID_LIMIT', {})
  }
  return chosen
}

export function likeContains(query: unknown): string {
  if (typeof query !== 'string') throw new BreadError('Query must be a string.', 'INVALID_QUERY', {})
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}

export function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function parseJsonText(text: string): unknown {
  // mysql2 may already have decoded a JSON string. Parsing that again turns
  // "keep" into a failure, and a numeric string into a number.
  const head = text.trimStart()[0]
  if (head !== '{' && head !== '[' && head !== '"') return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function jsonValue(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'string') return parseJsonText(value)
  if (value instanceof Uint8Array) return parseJsonText(new TextDecoder().decode(value))
  return value
}
