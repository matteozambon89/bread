import { type A2ABread, resolveAgentMeta } from '../agent-meta.js'

export interface AgentCardV03 {
  protocolVersion: '0.3.0'
  name: string
  description: string
  url: string
  version: string
  capabilities: { streaming: boolean; pushNotifications: false; stateTransitionHistory: false }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: { id: string; name: string; description: string; tags: string[] }[]
}

export interface A2AServerConfigV03 {
  agentId: string
  url: string
  name?: string
  description?: string
  version?: string
}

export function buildAgentCardV03(bread: A2ABread, agentId: string, config: A2AServerConfigV03): AgentCardV03 {
  const name = config.name ?? agentId
  const meta = resolveAgentMeta(bread, agentId, name)
  return {
    protocolVersion: '0.3.0',
    name,
    description: config.description ?? meta.description,
    url: config.url,
    version: config.version ?? '0.1.0',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: meta.skills,
  }
}
