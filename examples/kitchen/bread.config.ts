import { defineConfig } from '@breadai/core'
import { graph } from '@breadai/graph-neo4j'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import { z } from 'zod'

const username = process.env.NEO4J_USERNAME
const password = process.env.NEO4J_PASSWORD

// A null tenant is its own scope. Both sides have to be null; a null
// parameter must not match a node that belongs to some other tenant.
const stations = `MATCH (node:KitchenStation)
WHERE (node.tenant IS NULL AND $tenant IS NULL) OR node.tenant = $tenant
RETURN node.name AS name`

const nextStation = `MATCH (from:KitchenStation {name: $from})
WHERE (from.tenant IS NULL AND $tenant IS NULL) OR from.tenant = $tenant
MATCH (from)-[:NEXT]->(next:KitchenStation)
WHERE (next.tenant IS NULL AND $tenant IS NULL) OR next.tenant = $tenant
RETURN next.name AS name`

const markVisited = `MATCH (node:KitchenStation {name: $station})
WHERE (node.tenant IS NULL AND $tenant IS NULL) OR node.tenant = $tenant
CREATE (visit:KitchenVisit)
SET visit.agentId = $agentId,
    visit.sessionId = $sessionId,
    visit.subject = $subject,
    visit.tenant = $tenant
CREATE (visit)-[:WALKED]->(node)
RETURN node.name AS station`

export default defineConfig({
  entrypoints: ['walker'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  graph: graph({
    url: process.env.NEO4J_URL ?? 'bolt://127.0.0.1:7687',
    ...(username && password ? { auth: { username, password } } : {}),
  }),
  graphCatalog: {
    stations: {
      description: 'List kitchen stations in this tenant scope',
      statement: stations,
      mode: 'read',
      schema: z.object({}),
    },
    next_station: {
      description: 'Name the station one NEXT hop from this one, in the same tenant scope',
      statement: nextStation,
      mode: 'read',
      schema: z.object({ from: z.string() }),
    },
    mark_visited: {
      description: 'Record that this run walked a station',
      statement: markVisited,
      mode: 'write',
      requireTenant: false,
      schema: z.object({ station: z.string() }),
    },
  },
})
