import { z } from 'zod'

// MCP tools advertise a JSON Schema for their input. The AI SDK wants a zod
// schema. This is a pragmatic converter for the shapes MCP tools use in
// practice (objects of primitives, arrays, enums, local $ref/oneOf/anyOf/allOf
// combinators, nullable via a 'null' type-array entry); anything else falls
// back to `z.unknown()` so the tool stays callable.
export interface JSONSchema {
  type?: string | string[]
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  enum?: unknown[]
  const?: unknown
  description?: string
  $ref?: string
  oneOf?: JSONSchema[]
  anyOf?: JSONSchema[]
  allOf?: JSONSchema[]
  $defs?: Record<string, JSONSchema>
  definitions?: Record<string, JSONSchema>
}

function withDesc(schema: z.ZodTypeAny, src: JSONSchema): z.ZodTypeAny {
  return src.description ? schema.describe(src.description) : schema
}

// Only local refs into the same document's $defs/definitions — every
// real-world MCP tool schema observed is one self-contained document, so a
// remote/file $ref would need a fetch+cache design this converter doesn't do.
function resolveRef(ref: string, root: JSONSchema): JSONSchema {
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  if (!match) {
    throw new Error(
      `jsonSchemaToZod: unsupported $ref "${ref}" — only local "#/$defs/..." and "#/definitions/..." refs are supported`,
    )
  }
  const bucket = match[1] as '$defs' | 'definitions'
  const name = match[2]!
  const resolved = (bucket === '$defs' ? root.$defs : root.definitions)?.[name]
  if (!resolved) {
    throw new Error(`jsonSchemaToZod: $ref "${ref}" not found in root schema's ${bucket}`)
  }
  return resolved
}

function unionOf(branches: z.ZodTypeAny[]): z.ZodTypeAny {
  return branches.length === 1
    ? branches[0]!
    : z.union(branches as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
}

// allOf composes schemas ("extends"); object branches merge their shapes,
// anything else falls back to a runtime intersection.
function mergeAll(branches: z.ZodTypeAny[]): z.ZodTypeAny {
  return branches.reduce((acc, s) =>
    acc instanceof z.ZodObject && s instanceof z.ZodObject ? acc.merge(s) : z.intersection(acc, s),
  )
}

function convert(schema: JSONSchema | undefined, root: JSONSchema): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown()

  if (schema.$ref) return convert(resolveRef(schema.$ref, root), root)

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return withDesc(unionOf(schema.oneOf.map((s) => convert(s, root))), schema)
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return withDesc(unionOf(schema.anyOf.map((s) => convert(s, root))), schema)
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return withDesc(mergeAll(schema.allOf.map((s) => convert(s, root))), schema)
  }

  if (schema.const !== undefined) {
    return withDesc(z.literal(schema.const as string | number | boolean), schema)
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum
    if (values.every((v) => typeof v === 'string')) {
      return z.enum(values as [string, ...string[]])
    }
    const lits = values.map((v) => z.literal(v as string | number | boolean))
    return unionOf(lits)
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const nullable = types.includes('null')
  const primary = types.find((t) => t !== 'null')

  const base = ((): z.ZodTypeAny => {
    switch (primary) {
      case 'string':
        return z.string()
      case 'number':
      case 'integer':
        return z.number()
      case 'boolean':
        return z.boolean()
      case 'array':
        return z.array(convert(schema.items, root))
      case 'object': {
        const shape: Record<string, z.ZodTypeAny> = {}
        const required = new Set(schema.required ?? [])
        for (const [key, value] of Object.entries(schema.properties ?? {})) {
          const child = convert(value, root)
          shape[key] = required.has(key) ? child : child.optional()
        }
        return z.object(shape)
      }
      default:
        // A bare `type: 'null'` (or `['null']` with nothing else) means
        // "only null is valid" — distinct from no `type` at all, which
        // means "anything goes."
        return nullable ? z.null() : z.unknown()
    }
  })()

  return withDesc(nullable && primary !== undefined ? base.nullable() : base, schema)
}

export function jsonSchemaToZod(schema: JSONSchema | undefined): z.ZodTypeAny {
  return convert(schema, schema ?? {})
}
