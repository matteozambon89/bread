import { runTransportContract } from '@bread/test-utils'
import { transport } from '@bread/transport-http-chunked'

// transport() delegates its pub/sub+replay to the embedded streamTransport(),
// so the full duplex contract passes with no skips — same as core's own test.
runTransportContract('@bread/transport-http-chunked', () => transport())
