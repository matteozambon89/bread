import { runRunOwnerContract } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-chunked'

runRunOwnerContract('@breadai/transport-http-chunked', () => transport())
