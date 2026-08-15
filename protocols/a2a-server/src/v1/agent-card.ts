import { type A2ABread, resolveAgentMeta } from '../agent-meta.js'

export interface AgentCardV1 {
  name: string
  description: string
  supportedInterfaces: { url: string; protocolBinding: 'JSONRPC'; protocolVersion: '1.0' }[]
  version: string
  capabilities: { streaming: boolean; pushNotifications: false; extendedAgentCard: false }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: { id: string; name: string; description: string; tags: string[] }[]
}

export interface A2AServerConfigV1 {
  agentId: string
  url: string
  name?: string
  description?: string
  version?: string
}

export function buildAgentCardV1(bread: A2ABread, agentId: string, config: A2AServerConfigV1): AgentCardV1 {
  const name = config.name ?? agentId
  const meta = resolveAgentMeta(bread, agentId, name)
  return {
    name,
    description: config.description ?? meta.description,
    supportedInterfaces: [{ url: config.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: config.version ?? '0.1.0',
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: meta.skills,
  }
}
