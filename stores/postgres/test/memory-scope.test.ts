import { expect, test } from 'bun:test'
import { store } from '@breadai/store-postgres'
import { withPglite } from '@breadai/test-utils'

const ada = { iss: 'https://idp.example', sub: 'ada', tenant: 'one' }
const bob = { iss: 'https://idp.example', sub: 'bob', tenant: 'two' }

test('vector search and list stay inside agent and principal', async () => {
  const pg = await withPglite({ vector: true })
  const backend = store({
    url: pg.url,
    embed: async () => [0.1, 0.2, 0.3],
  })
  try {
    await backend.migrate?.()
    const own = await backend.addMemory!({
      agentId: 'memory',
      principal: ada,
      content: 'shared fact',
    })
    await backend.addMemory!({
      agentId: 'other',
      principal: ada,
      content: 'shared fact',
    })

    expect(
      await backend.searchMemories!({
        agentId: 'memory',
        principal: bob,
        query: 'shared fact',
      }),
    ).toEqual([])
    expect(
      await backend.listMemories!({
        agentId: 'memory',
        principal: bob,
      }),
    ).toEqual([])

    const bobs = await backend.addMemory!({
      agentId: 'memory',
      principal: bob,
      content: 'shared fact',
    })
    expect(
      (
        await backend.searchMemories!({
          agentId: 'memory',
          principal: bob,
          query: 'shared fact',
        })
      ).map((row) => row.id),
    ).toEqual([bobs.id])
    expect(
      (
        await backend.listMemories!({
          agentId: 'memory',
          principal: bob,
        })
      ).map((row) => row.id),
    ).toEqual([bobs.id])

    const ownSearch = await backend.searchMemories!({
      agentId: 'memory',
      principal: { iss: ada.iss, sub: ada.sub, tenant: 'other' },
      query: 'shared',
    })
    const ownList = await backend.listMemories!({
      agentId: 'memory',
      principal: { iss: ada.iss, sub: ada.sub },
    })
    expect(ownSearch.map((row) => row.id)).toEqual([own.id])
    expect(ownList.map((row) => row.id)).toEqual([own.id])
  } finally {
    await backend.close?.()
    await pg.close()
  }
})
