import { runTransportContract } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-sse'

// transport() delegates its pub/sub+replay to the embedded streamTransport(),
// so the full duplex contract passes with no skips.
runTransportContract('@breadai/transport-http-sse', () => transport())
