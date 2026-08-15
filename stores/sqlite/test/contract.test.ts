import { store } from '@breadai/store-sqlite'
import { runStoreContract } from '@breadai/test-utils'

// ':memory:' keeps each store fully ephemeral — no temp files, hermetic.
runStoreContract('sqlite-bun', () => store({ path: ':memory:' }))
