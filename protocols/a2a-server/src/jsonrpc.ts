// Version-agnostic JSON-RPC 2.0 envelope handling, shared by the v0.3 and
// v1.0 payload handlers — only the method name and params/result shapes
// differ between spec versions, not the envelope itself.

export interface JsonRpcEnvelope {
  id: unknown
  method: string
  params: unknown
}

export type EnvelopeResult = { ok: true; envelope: JsonRpcEnvelope } | { ok: false; response: Response }

export function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

export function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result })
}

export async function parseEnvelope(req: Request): Promise<EnvelopeResult> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return { ok: false, response: jsonRpcError(null, -32700, 'Parse error') }
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    (body as Record<string, unknown>).jsonrpc !== '2.0' ||
    typeof (body as Record<string, unknown>).method !== 'string'
  ) {
    const id = (body as Record<string, unknown> | null)?.id ?? null
    return { ok: false, response: jsonRpcError(id, -32600, 'Invalid Request') }
  }
  const { id, method, params } = body as Record<string, unknown>
  return { ok: true, envelope: { id, method: method as string, params } }
}
