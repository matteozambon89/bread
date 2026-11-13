import { z } from 'zod'
import { assertName } from './permissions.js'
import type { Graph, GraphQuery } from './storage/graph.js'
import type { ToolContext, ToolDefinition } from './types.js'
import { BreadError } from './types.js'

const RESERVED_PARAMS = new Set(['agentId', 'sessionId', 'tenant', 'subject', 'statement'])

// A comment is whitespace, so removing one must leave a gap or LOAD and CSV join.
// Backticks quote each name: `apoc`.`load` is still that call. Letters inside one
// identifier, such as apocryphal, are not.
const DANGEROUS_CALL = /\bLOAD\s+CSV\b|\bapoc\s*\.\s*(?:cypher|load|import)\b/i

export function assertGraphQuery(name: string, query: GraphQuery): void {
  assertName('graph query', name)
  if (!(query.schema instanceof z.ZodObject)) {
    throw new BreadError('Graph query schema must be an object.', 'GRAPH_QUERY_INVALID', { query: name })
  }
  for (const key of Object.keys(query.schema.shape)) {
    if (RESERVED_PARAMS.has(key)) {
      throw new BreadError('Graph parameter is reserved.', 'GRAPH_PARAM_RESERVED', { query: name })
    }
  }
}

function stripCypherComments(statement: string): string {
  let out = ''
  let i = 0
  while (i < statement.length) {
    if (statement.startsWith('/*', i)) {
      const end = statement.indexOf('*/', i + 2)
      i = end === -1 ? statement.length : end + 2
      out += ' '
      continue
    }
    if (statement.startsWith('//', i)) {
      // Cypher ends a line at LF, CR, or CRLF. Stopping only at LF hides the rest.
      let end = i + 2
      while (end < statement.length && statement[end] !== '\n' && statement[end] !== '\r') end += 1
      if (statement.startsWith('\r\n', end)) end += 2
      else if (end < statement.length) end += 1
      i = end
      out += ' '
      continue
    }
    const quote = statement[i]
    if (quote === "'" || quote === '"') {
      out += quote
      i += 1
      while (i < statement.length) {
        const ch = statement[i]!
        out += ch
        i += 1
        if (ch === '\\' && i < statement.length) {
          out += statement[i]
          i += 1
          continue
        }
        if (ch === quote) break
      }
      continue
    }
    if (quote === '`') {
      out += quote
      i += 1
      while (i < statement.length) {
        const ch = statement[i]!
        out += ch
        i += 1
        if (ch === '`') {
          if (i < statement.length && statement[i] === '`') {
            out += statement[i]
            i += 1
            continue
          }
          break
        }
      }
      continue
    }
    out += statement[i]
    i += 1
  }
  return out
}

function statementFetchesParameters(statement: string): boolean {
  // U+001C–U+001F and U+0085 separate Cypher keywords. JavaScript \s does not include them.
  const visible = stripCypherComments(statement)
    .replaceAll('`', '')
    .replaceAll(/[\u001c-\u001f\u0085]/g, ' ')
  return DANGEROUS_CALL.test(visible)
}

function schemaHasParameter(schema: z.ZodType): boolean {
  return schema instanceof z.ZodObject && Object.keys(schema.shape).length > 0
}

function valueHasKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => valueHasKey(entry))
  if (value === null || typeof value !== 'object') return false
  return Object.keys(value as Record<string, unknown>).length > 0
}

export function createGraphTool(name: string, query: GraphQuery, graph: Graph): ToolDefinition {
  assertGraphQuery(name, query)
  return {
    name: `core_${name}`,
    description: query.description,
    schema: query.schema,
    ...(query.mode === 'write' ? { ask: true as const } : {}),
    async execute(args, ctx: ToolContext) {
      const parsed = query.schema.parse(args)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BreadError('Graph query schema must be an object.', 'GRAPH_QUERY_INVALID', { query: name })
      }
      const record = parsed as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (RESERVED_PARAMS.has(key)) {
          throw new BreadError('Graph parameter is reserved.', 'GRAPH_PARAM_RESERVED', { query: name })
        }
      }
      if (statementFetchesParameters(query.statement) && (schemaHasParameter(query.schema) || valueHasKey(record))) {
        throw new BreadError('Graph parameter is not allowed.', 'GRAPH_PARAM_REJECTED', { query: name })
      }

      const params: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        if (!RESERVED_PARAMS.has(key)) params[key] = value
      }
      params.agentId = ctx.agentId
      params.sessionId = ctx.sessionId
      // Null is one tenant scope. Omitting the key is not that bind.
      params.tenant = ctx.principal?.tenant ?? null
      params.subject = ctx.principal?.sub ?? null

      const requireTenant = query.requireTenant ?? query.mode === 'write'
      if (requireTenant && params.tenant === null) {
        throw new BreadError('Graph query requires a tenant.', 'GRAPH_TENANT_REQUIRED', { query: name })
      }

      try {
        return ctx.signal !== undefined
          ? await graph.run(query.statement, params, query.mode, ctx.signal)
          : await graph.run(query.statement, params, query.mode)
      } catch {
        throw new BreadError('Graph query failed.', 'GRAPH_QUERY_FAILED', { query: name })
      }
    },
  }
}
