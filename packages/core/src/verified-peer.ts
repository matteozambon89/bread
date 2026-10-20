/** @internal Leaf the mTLS listener verified. Client headers cannot set this. */
export interface VerifiedPeerCertificate {
  subjectCn: string
  issuerCn: string
  fingerprint256: string
  /** Subject OU values in certificate order. Empty when the cert has none. */
  organizationalUnits: string[]
}

const peers = new WeakMap<Request, VerifiedPeerCertificate>()

/** @internal Only the mTLS listener writes this. */
export function attachVerifiedPeer(request: Request, peer: VerifiedPeerCertificate): void {
  peers.set(request, peer)
}

/** @internal */
export function verifiedPeer(request: Request): VerifiedPeerCertificate | undefined {
  return peers.get(request)
}
