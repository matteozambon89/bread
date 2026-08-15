import { z } from 'zod'

// MCP expects a top-level JSON-Schema `object` for a tool's input/output. A
// zod object schema already satisfies that and is passed straight through
// (giving the exposed tool its real, structured schema); anything else (a
// bare `z.string()`, etc.) is wrapped in a single-field object so the tool
// stays spec-compliant.
export function toMcpInputSchema(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodObject ? schema : z.object({ input: schema })
}

export function toMcpOutputSchema(schema: z.ZodType | undefined): z.ZodType | undefined {
  if (!schema) return undefined
  return schema instanceof z.ZodObject ? schema : z.object({ output: schema })
}

export function isObjectSchema(schema: z.ZodType | undefined): boolean {
  return schema instanceof z.ZodObject
}

// Undoes the wrap above: given the real args an MCP caller sent (already
// validated against `toMcpInputSchema`'s shape), recover the value the
// underlying agent/task/tool actually expects.
export function unwrapInput(args: unknown, wasWrapped: boolean): unknown {
  return wasWrapped ? (args as { input: unknown }).input : args
}

// Always emits both `structuredContent` (required by the SDK whenever the
// tool was registered with an outputSchema) and a text fallback (for clients
// that only read `content`), so nothing is lost either way.
export function toStructured(
  raw: unknown,
  wasWrapped: boolean,
): { structuredContent: Record<string, unknown>; content: { type: 'text'; text: string }[] } {
  const structuredContent = wasWrapped ? { output: raw } : (raw as Record<string, unknown>)
  return {
    structuredContent,
    content: [{ type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }],
  }
}
