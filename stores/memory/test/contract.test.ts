import { store } from '@bread/store-memory'
import { runStoreContract } from '@bread/test-utils'

runStoreContract('memory', () => store())
