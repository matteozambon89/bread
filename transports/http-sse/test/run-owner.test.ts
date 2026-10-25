import { runRunOwnerContract } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-sse'

runRunOwnerContract('@breadai/transport-http-sse', () => transport())
