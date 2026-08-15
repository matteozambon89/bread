import { describe, expect, test } from 'bun:test'
import { jsonSchemaToZod } from '@bread/protocol-mcp-client'

describe('jsonSchemaToZod', () => {
  test('converts an object schema with required fields', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
    })
    expect(schema.safeParse({ name: 'Ada', age: 36 }).success).toBe(true)
    expect(schema.safeParse({ age: 36 }).success).toBe(false)
  })

  test('rejects a value of the wrong primitive type', () => {
    const schema = jsonSchemaToZod({ type: 'object', properties: { n: { type: 'number' } } })
    expect(schema.safeParse({ n: 'not a number' }).success).toBe(false)
  })

  test('a string enum accepts members and rejects outsiders', () => {
    const schema = jsonSchemaToZod({ enum: ['red', 'green', 'blue'] })
    expect(schema.safeParse('green').success).toBe(true)
    expect(schema.safeParse('purple').success).toBe(false)
  })

  test('a mixed-literal enum becomes a literal union', () => {
    const schema = jsonSchemaToZod({ enum: ['auto', 42, true] })
    expect(schema.safeParse(42).success).toBe(true)
    expect(schema.safeParse(true).success).toBe(true)
    expect(schema.safeParse('manual').success).toBe(false)
  })

  test('arrays validate their item schema, including object items', () => {
    const schema = jsonSchemaToZod({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    })
    expect(schema.safeParse([{ id: 1 }, { id: 2 }]).success).toBe(true)
    expect(schema.safeParse([{ id: 'x' }]).success).toBe(false)
  })

  test('nested objects honor required at every level', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' }, nick: { type: 'string' } },
          required: ['name'],
        },
      },
      required: ['user'],
    })
    expect(schema.safeParse({ user: { name: 'Ada' } }).success).toBe(true)
    expect(schema.safeParse({ user: {} }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  test('a type array uses its first non-null entry, and accepts null', () => {
    const schema = jsonSchemaToZod({ type: ['string', 'null'] })
    expect(schema.safeParse('ok').success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse(7).success).toBe(false)
  })

  test('unrecognized shapes fall back to accepting anything', () => {
    expect(jsonSchemaToZod(undefined).safeParse('whatever').success).toBe(true)
    expect(jsonSchemaToZod({ type: 'tuple' }).safeParse([1, 2]).success).toBe(true)
  })

  test('a local $ref resolves against the root schema\'s $defs', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { home: { $ref: '#/$defs/Address' } },
      required: ['home'],
      $defs: {
        Address: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    })
    expect(schema.safeParse({ home: { city: 'Turin' } }).success).toBe(true)
    expect(schema.safeParse({ home: {} }).success).toBe(false)
  })

  test('a local $ref resolves against the root schema\'s definitions', () => {
    const schema = jsonSchemaToZod({
      $ref: '#/definitions/Name',
      definitions: { Name: { type: 'string' } },
    })
    expect(schema.safeParse('Ada').success).toBe(true)
    expect(schema.safeParse(1).success).toBe(false)
  })

  test('an unsupported (non-local) $ref throws rather than silently degrading', () => {
    expect(() => jsonSchemaToZod({ $ref: 'https://example.com/schema.json' })).toThrow(/unsupported \$ref/)
  })

  test('a missing $ref target throws', () => {
    expect(() => jsonSchemaToZod({ $ref: '#/$defs/Missing', $defs: {} })).toThrow(/not found/)
  })

  test('anyOf becomes a union — the common Optional[X]-as-null-branch shape', () => {
    const schema = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(schema.safeParse('x').success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse(1).success).toBe(false)
  })

  test('oneOf of object variants accepts either shape', () => {
    const schema = jsonSchemaToZod({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' }, x: { type: 'number' } }, required: ['kind', 'x'] },
        { type: 'object', properties: { kind: { const: 'b' }, y: { type: 'string' } }, required: ['kind', 'y'] },
      ],
    })
    expect(schema.safeParse({ kind: 'a', x: 1 }).success).toBe(true)
    expect(schema.safeParse({ kind: 'b', y: 'z' }).success).toBe(true)
    expect(schema.safeParse({ kind: 'c' }).success).toBe(false)
  })

  test('allOf merges object branches (schema composition/"extends")', () => {
    const schema = jsonSchemaToZod({
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        { type: 'object', properties: { age: { type: 'number' } }, required: ['age'] },
      ],
    })
    expect(schema.safeParse({ name: 'Ada', age: 36 }).success).toBe(true)
    expect(schema.safeParse({ name: 'Ada' }).success).toBe(false)
  })

  test('const becomes a single-value literal', () => {
    const schema = jsonSchemaToZod({ const: 'fixed' })
    expect(schema.safeParse('fixed').success).toBe(true)
    expect(schema.safeParse('other').success).toBe(false)
  })
})
