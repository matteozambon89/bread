import { BreadError, type Principal } from '@breadai/core'

export const MAX_LIMIT = 1000

const TAG_KEY = /^[a-z][a-z0-9_]{0,31}$/
const RESERVED_KEYS = new Set(['constructor', 'prototype', '__proto__'])
const MAX_TAGS = 16
const MAX_TAG_VALUE = 256

export function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BreadError('Expected a string.', code)
  }
  return value
}

export function filterString(value: unknown): string {
  if (typeof value !== 'string') throw new BreadError('Expected a string.', 'INVALID_FILTER')
  return value
}

export interface TagPair {
  k: string
  v: string
}

export function tagPairs(tags: Record<string, string> | undefined): TagPair[] | undefined {
  if (tags === undefined) return undefined
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new BreadError('Tag key is not allowed.', 'INVALID_TAG')
  }
  const keys = Object.keys(tags)
  if (keys.length > MAX_TAGS) throw new BreadError('Tag key is not allowed.', 'INVALID_TAG')
  const pairs: TagPair[] = []
  for (const key of keys) {
    if (!TAG_KEY.test(key) || RESERVED_KEYS.has(key) || key.startsWith('$') || key.includes('.')) {
      throw new BreadError('Tag key is not allowed.', 'INVALID_TAG')
    }
    const value = tags[key]
    if (typeof value !== 'string' || value.length > MAX_TAG_VALUE) {
      throw new BreadError('Tag key is not allowed.', 'INVALID_TAG')
    }
    pairs.push({ k: key, v: value })
  }
  return pairs
}

export function storedPrincipal(principal: Principal): {
  iss: string
  sub: string
  tenant?: string
  roles?: string[]
} {
  const iss = requiredString(principal?.iss, 'INVALID_PRINCIPAL')
  const sub = requiredString(principal?.sub, 'INVALID_PRINCIPAL')
  const stored: { iss: string; sub: string; tenant?: string; roles?: string[] } = { iss, sub }
  if (principal.tenant !== undefined) stored.tenant = requiredString(principal.tenant, 'INVALID_PRINCIPAL')
  if (principal.roles !== undefined) {
    if (!Array.isArray(principal.roles) || principal.roles.some((role) => typeof role !== 'string')) {
      throw new BreadError('Expected a string.', 'INVALID_PRINCIPAL')
    }
    stored.roles = [...principal.roles]
  }
  return stored
}

export function boundedLimit(limit: number | undefined, fallback: number): number {
  const chosen = limit === undefined ? fallback : limit
  if (typeof chosen !== 'number' || !Number.isInteger(chosen) || chosen < 1 || chosen > MAX_LIMIT) {
    throw new BreadError('Search limit is invalid.', 'INVALID_LIMIT')
  }
  return chosen
}

export function keywordPattern(query: unknown): string {
  if (typeof query !== 'string') throw new BreadError('Search query is invalid.', 'INVALID_QUERY')
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function finiteInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BreadError('Expected an integer.', code)
  }
  return value
}
