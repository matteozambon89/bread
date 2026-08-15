import { streamTransport } from '@breadai/core'
import { runTransportContract } from '@breadai/test-utils'

// The embedded default transport must satisfy the same contract every other
// implementation (e.g. @breadai/transport-redis) is held to — replay included,
// since it's the reference conformer.
runTransportContract('streamTransport', () => streamTransport())
