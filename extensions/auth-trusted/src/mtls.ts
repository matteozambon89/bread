import type { AuthIdentity, BreadAuthStrategy, Principal } from '@breadai/core'
import { verifiedPeer, type VerifiedPeerCertificate } from '@breadai/core'

export interface MtlsOptions {
  /** Leaf issuer CN. Required. Matched exactly. Not a URI. */
  issuer: string
  /**
   * Copies one subject OU onto `principal.tenant`.
   * Only `ou` is accepted. Omit to leave `tenant` unset.
   */
  tenantField?: 'ou'
}

/** Read `principal` from the client certificate the mTLS listener verified. No signer. */
export function mtlsStrategy(opts: MtlsOptions): BreadAuthStrategy {
  if (typeof opts.issuer !== 'string' || opts.issuer.length === 0) {
    throw new Error('auth-trusted: configure `issuer`')
  }
  if (opts.tenantField !== undefined && opts.tenantField !== 'ou') {
    throw new Error('auth-trusted: `tenantField` must be "ou" when set')
  }

  const issuer = opts.issuer
  const tenantField = opts.tenantField

  return {
    name: 'trusted-mtls',
    authenticate(req): AuthIdentity | null {
      const peer = verifiedPeer(req)
      if (!peer) return null
      if (peer.subjectCn.length === 0 || peer.issuerCn.length === 0) return null
      if (peer.issuerCn !== issuer) return null

      const principal: Principal = { iss: peer.issuerCn, sub: peer.subjectCn }
      if (tenantField === 'ou') {
        const tenant = oneOu(peer)
        if (tenant === undefined) return null
        principal.tenant = tenant
      }

      return {
        subject: peer.subjectCn,
        claims: {
          iss: peer.issuerCn,
          sub: peer.subjectCn,
          fingerprint256: peer.fingerprint256,
        },
        principal,
      }
    },
  }
}

function oneOu(peer: VerifiedPeerCertificate): string | undefined {
  const units = peer.organizationalUnits
  if (units.length !== 1) return undefined
  const ou = units[0]
  if (ou === undefined || ou.length === 0) return undefined
  return ou
}
