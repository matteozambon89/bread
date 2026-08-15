import { type FileOutput, isFileOutput } from '@bread/core'
import { v7 as uuidv7 } from 'uuid'
import { jsonRpcError, jsonRpcResult, parseEnvelope } from '../jsonrpc.js'
import type { A2ABread } from '../agent-meta.js'
import { extractInput, toOutputFilePart } from './message.js'
import { handleStreamRequestV1 } from './stream.js'
import { handleTasksCancelV1, handleTasksGetV1, handleTasksResubscribeV1 } from './tasks.js'

export async function handleRpcRequestV1(
  bread: A2ABread,
  agentId: string,
  req: Request,
  cancelRegistry: Map<string, AbortController>,
): Promise<Response> {
  const parsed = await parseEnvelope(req)
  if (!parsed.ok) return parsed.response
  const { id, method, params } = parsed.envelope
  if (method === 'SendStreamingMessage') return handleStreamRequestV1(bread, agentId, id, params, cancelRegistry)
  if (method === 'GetTask') return handleTasksGetV1(bread, agentId, id, params)
  if (method === 'SubscribeToTask') return handleTasksResubscribeV1(bread, agentId, id, params, req)
  if (method === 'CancelTask') return handleTasksCancelV1(bread, agentId, id, params, cancelRegistry)
  if (method !== 'SendMessage') return jsonRpcError(id, -32601, `Method not found: ${method}`)

  const extracted = await extractInput(params, bread.blobStore)
  if (!extracted.ok) return jsonRpcError(id, -32602, extracted.error)

  let output: unknown
  let files: FileOutput[] | undefined
  try {
    ;({ output, files } = await bread.run(agentId, extracted.input, { mode: 'sync' }))
  } catch (err) {
    console.error(`a2a_server (v1.0): agent "${agentId}" run failed:`, err)
    return jsonRpcError(id, -32603, 'Internal error')
  }

  const parts: unknown[] = (files ?? []).map(toOutputFilePart)
  if (isFileOutput(output)) {
    parts.push(toOutputFilePart(output))
  } else if (typeof output === 'string') {
    parts.push({ text: output })
  } else {
    parts.push({ data: output, mediaType: 'application/json' })
  }

  return jsonRpcResult(id, {
    message: {
      messageId: uuidv7(),
      role: 'ROLE_AGENT',
      parts,
      ...(extracted.contextId ? { contextId: extracted.contextId } : {}),
    },
  })
}
