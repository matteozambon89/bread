import { runTransportContract } from '@bread/test-utils'
import { transport } from '@bread/transport-http-sse'

// transport() delegates its pub/sub+replay to the embedded streamTransport(),
// so the full duplex contract passes with no skips.
runTransportContract('@bread/transport-http-sse', () => transport())
