import { store } from '@bread/store-sqlite'
import { runStoreContract } from '@bread/test-utils'

// ':memory:' keeps each store fully ephemeral — no temp files, hermetic.
runStoreContract('sqlite-bun', () => store({ path: ':memory:' }))
