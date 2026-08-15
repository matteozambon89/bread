// A2A's streaming frames are JSON-RPC-wrapped ({jsonrpc,id,result}), unlike
// the {type,payload} wire format @breadai/test-utils' parseSse/readSse are
// typed around — a one-off parser here beats retyping a shared test helper
// for a single caller.
export function parseJsonRpcSse(body: string): Array<{ jsonrpc: '2.0'; id: unknown; result: unknown }> {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: '))?.slice(6))
    .filter((data): data is string => !!data)
    .map((data) => JSON.parse(data))
}

// Incrementally reads a streaming Response body until its accumulated text
// contains `marker` — the sync point for "the replay has reached this far",
// used by mid-stream tasks/resubscribe reattach tests. Mirrors
// packages/server/test/runs-stream.test.ts's local readBodyUntil.
export async function readBodyUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: { text: string },
  marker: string,
): Promise<void> {
  const decoder = new TextDecoder()
  while (!acc.text.includes(marker)) {
    const { done, value } = await reader.read()
    if (done) return
    acc.text += decoder.decode(value, { stream: true })
  }
}

export async function readBodyToEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: { text: string },
): Promise<void> {
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    acc.text += decoder.decode(value, { stream: true })
  }
}
