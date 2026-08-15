import { runTransportContract } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-chunked'

// transport() delegates its pub/sub+replay to the embedded streamTransport(),
// so the full duplex contract passes with no skips — same as core's own test.
runTransportContract('@breadai/transport-http-chunked', () => transport())
