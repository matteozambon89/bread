import { streamTransport } from '@bread/core'
import { runTransportContract } from '@bread/test-utils'

// The embedded default transport must satisfy the same contract every other
// implementation (e.g. @bread/transport-redis) is held to — replay included,
// since it's the reference conformer.
runTransportContract('streamTransport', () => streamTransport())
