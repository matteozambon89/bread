// Imports fine but does not export a default AgentDefinition — hits loadAgents'
// "must export a default AgentDefinition" error+continue branch.
export const notAnAgent = { foo: 'bar' }
