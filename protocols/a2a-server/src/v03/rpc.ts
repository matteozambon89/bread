import { type FileOutput, isFileOutput } from '@bread/core'
import { v7 as uuidv7 } from 'uuid'
import { jsonRpcError, jsonRpcResult, parseEnvelope } from '../jsonrpc.js'
import type { A2ABread } from '../agent-meta.js'
import { extractInput, toOutputFilePart } from './message.js'
import { handleStreamRequestV03 } from './stream.js'
import { handleTasksCancelV03, handleTasksGetV03, handleTasksResubscribeV03 } from './tasks.js'

export async function handleRpcRequestV03(
  bread: A2ABread,
  agentId: string,
  req: Request,
  cancelRegistry: Map<string, AbortController>,
): Promise<Response> {
  const parsed = await parseEnvelope(req)
  if (!parsed.ok) return parsed.response
  const { id, method, params } = parsed.envelope
  if (method === 'message/stream') return handleStreamRequestV03(bread, agentId, id, params, cancelRegistry)
  if (method === 'tasks/get') return handleTasksGetV03(bread, agentId, id, params)
  if (method === 'tasks/resubscribe') return handleTasksResubscribeV03(bread, agentId, id, params, req)
  if (method === 'tasks/cancel') return handleTasksCancelV03(bread, agentId, id, params, cancelRegistry)
  if (method !== 'message/send') return jsonRpcError(id, -32601, `Method not found: ${method}`)

  const extracted = await extractInput(params, bread.blobStore)
  if (!extracted.ok) return jsonRpcError(id, -32602, extracted.error)

  let output: unknown
  let files: FileOutput[] | undefined
  try {
    ;({ output, files } = await bread.run(agentId, extracted.input, { mode: 'sync' }))
  } catch (err) {
    console.error(`a2a_server (v0.3): agent "${agentId}" run failed:`, err)
    return jsonRpcError(id, -32603, 'Internal error')
  }

  const parts: unknown[] = (files ?? []).map(toOutputFilePart)
  if (isFileOutput(output)) {
    parts.push(toOutputFilePart(output))
  } else if (typeof output === 'string') {
    parts.push({ kind: 'text', text: output })
  } else {
    parts.push({ kind: 'data', data: output })
  }

  return jsonRpcResult(id, {
    messageId: uuidv7(),
    role: 'agent',
    kind: 'message',
    parts,
    ...(extracted.contextId ? { contextId: extracted.contextId } : {}),
  })
}
