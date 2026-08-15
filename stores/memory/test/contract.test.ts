import { store } from '@breadai/store-memory'
import { runStoreContract } from '@breadai/test-utils'

runStoreContract('memory', () => store())
