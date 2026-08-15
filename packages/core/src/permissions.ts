import { BreadError } from './types.js'

// ---------------------------------------------------------------------------
// Scopes & naming
// ---------------------------------------------------------------------------

// Single source of truth for the six reserved scopes — every other scope
// reference in this module (and the runner's origin tagging) reads from this
// instead of repeating the string literals. There is deliberately no
// per-integration scope (e.g. "mcp") — anything sourced from a plugin,
// including MCP tools, is tagged `plugin:<plugin-name>/<name>` like any other
// plugin's tools, so core never needs to know which protocols its plugins speak.
export const TOOL_SCOPES = {
  TOOL: 'tool',
  SKILL: 'skill',
  TASK: 'task',
  PLUGIN: 'plugin',
  CORE: 'core',
  HUMAN: 'human',
} as const

export type ToolScope = (typeof TOOL_SCOPES)[keyof typeof TOOL_SCOPES]

const RESERVED_SCOPES: ReadonlySet<ToolScope> = new Set(Object.values(TOOL_SCOPES))

// Scopes whose leaf/id carries a sub-identifier (the skill id or plugin name)
// between the scope and the tool's own name.
const SUB_SCOPES: ReadonlySet<ToolScope> = new Set([TOOL_SCOPES.SKILL, TOOL_SCOPES.PLUGIN])

export const NAME_RE = /^[a-z][a-z0-9_]*$/

export function assertName(kind: string, value: string): void {
  if (!NAME_RE.test(value)) {
    throw new BreadError(
      `${kind} name "${value}" must match ${NAME_RE} (lowercase snake_case, starting with a letter)`,
      'INVALID_NAME',
      { kind, value },
    )
  }
}

// Structured provenance for a runner-assembled tool — never reconstructed by
// parsing a leaf name back apart.
export interface ToolOrigin {
  scope: ToolScope
  sub?: string
  name: string
}

export function leafName(origin: ToolOrigin): string {
  if (SUB_SCOPES.has(origin.scope)) {
    if (!origin.sub) {
      throw new BreadError(
        `tool origin for scope "${origin.scope}" requires "sub"`,
        'INVALID_NAME',
        { origin },
      )
    }
    return `${origin.scope}_${origin.sub}_${origin.name}`
  }
  return `${origin.scope}_${origin.name}`
}

export function permId(origin: ToolOrigin): string {
  if (SUB_SCOPES.has(origin.scope)) {
    if (!origin.sub) {
      throw new BreadError(
        `tool origin for scope "${origin.scope}" requires "sub"`,
        'INVALID_NAME',
        { origin },
      )
    }
    return `${origin.scope}:${origin.sub}/${origin.name}`
  }
  return `${origin.scope}:${origin.name}`
}

// ---------------------------------------------------------------------------
// Selectors — config-facing strings in `permissions.{allow,ask,deny}`
// ---------------------------------------------------------------------------

// A parsed selector. `sub`/`name` of `'*'` globs the whole segment; a segment
// may also embed `*` as a partial glob (e.g. `read_*`, `get_*_by_id`) — each
// `*` matches zero or more `[a-z0-9_]` characters.
export interface ParsedSelector {
  scope: ToolScope
  sub?: string // present only for sub-scopes (skill/mcp/plugin); may embed '*'
  name: string // may embed '*'
}

const SEGMENT_RE = /^(\*|[a-z])[a-z0-9_*]*$/

export function parseSelector(selector: string): ParsedSelector {
  const fail = (reason: string): never => {
    throw new BreadError(`invalid permission selector "${selector}": ${reason}`, 'INVALID_PERMISSION', {
      selector,
    })
  }

  const colon = selector.indexOf(':')
  if (colon === -1) return fail('selectors must be scoped (e.g. "tool:name"), bare "*" is not allowed')

  const scope = selector.slice(0, colon) as ToolScope
  const rest = selector.slice(colon + 1)

  if (!RESERVED_SCOPES.has(scope)) {
    return fail(`unknown scope "${scope}" (expected one of: tool, skill, task, plugin, core, human)`)
  }
  if (scope === 'human') return fail('"human:" tools are exempt from permissions and may not appear in a selector')
  if (rest.length === 0) return fail('missing selector body after scope')

  const isSubScope = SUB_SCOPES.has(scope)

  if (rest === '*') return isSubScope ? { scope, sub: '*', name: '*' } : { scope, name: '*' }

  const slash = rest.indexOf('/')
  if (slash === -1) {
    if (isSubScope) {
      return fail(`scope "${scope}" requires a sub-id (e.g. "${scope}:server/name"), or "${scope}:*"`)
    }
    if (!SEGMENT_RE.test(rest)) return fail(`invalid name segment "${rest}"`)
    return { scope, name: rest }
  }

  if (!isSubScope) return fail(`scope "${scope}" does not take a sub-id; use "${scope}:name"`)
  const sub = rest.slice(0, slash)
  const name = rest.slice(slash + 1)
  if (name.indexOf('/') !== -1) return fail('selectors take at most one "/"')
  if (!SEGMENT_RE.test(sub)) return fail(`invalid sub segment "${sub}"`)
  if (!SEGMENT_RE.test(name)) return fail(`invalid name segment "${name}"`)
  return { scope, sub, name }
}

function segmentMatches(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === value) return true
  if (pattern === undefined || value === undefined) return false
  if (pattern === '*') return true
  if (!pattern.includes('*')) return false
  const re = new RegExp(`^${pattern.split('*').join('[a-z0-9_]*')}$`)
  return re.test(value)
}

export function matchesSelector(selector: string | ParsedSelector, origin: ToolOrigin): boolean {
  const parsed = typeof selector === 'string' ? parseSelector(selector) : selector
  if (parsed.scope !== origin.scope) return false
  return segmentMatches(parsed.sub, origin.sub) && segmentMatches(parsed.name, origin.name)
}

// ---------------------------------------------------------------------------
// Resolution — (allow ∪ ask) − deny, deny wins, ask wins over allow
// ---------------------------------------------------------------------------

export interface ToolPermissions {
  allow?: string[]
  ask?: string[]
  deny?: string[]
}

export interface ResolvedPermissions {
  allowed: ToolOrigin[]
  gated: Set<string> // leaf names requiring approval before they may execute
}

function matchesAny(selectors: string[] | undefined, origin: ToolOrigin): boolean {
  if (!selectors || selectors.length === 0) return false
  return selectors.some((s) => matchesSelector(s, origin))
}

export function resolvePermissions(
  origins: ToolOrigin[],
  permissions?: ToolPermissions,
): ResolvedPermissions {
  const allowed: ToolOrigin[] = []
  const gated = new Set<string>()

  const hasAllowlist = !!permissions?.allow && permissions.allow.length > 0

  for (const origin of origins) {
    if (origin.scope === 'human') {
      allowed.push(origin)
      continue
    }

    const isAsked = matchesAny(permissions?.ask, origin)
    const isAllowed = isAsked || !hasAllowlist || matchesAny(permissions?.allow, origin)
    const isDenied = matchesAny(permissions?.deny, origin)

    if (!isAllowed || isDenied) continue

    allowed.push(origin)
    if (isAsked) gated.add(leafName(origin))
  }

  return { allowed, gated }
}
