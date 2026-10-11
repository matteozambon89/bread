import { BreadError, isLoopbackHostname, type BreadConfig } from '@breadai/core'

export function hasAuthPlugin(config: BreadConfig): boolean {
  return (config.plugins ?? []).some((plugin) => plugin.name === 'auth')
}

function hasAuthorize(config: BreadConfig): boolean {
  return typeof config.server?.authorize === 'function'
}

// No auth on loopback is the only listen that trusts Host. A public bind can
// be reached with a spoofed Host, and auth without authorize cannot decide.
export function assertHttpAuth(config: BreadConfig, bindHost: string): void {
  if (!hasAuthPlugin(config) && isLoopbackHostname(bindHost)) return
  if (hasAuthPlugin(config) && hasAuthorize(config)) return
  throw new BreadError(
    'Auth is not configured. Register authPlugin() and set server.authorize, or bind a loopback ' +
      'host (localhost, 127.0.0.1, ::1, or [::1]). A spoofed Host header is why a public bind ' +
      'cannot rely on the header check. Auth without authorize does not listen, and authorize ' +
      'without auth does not listen on a public bind.',
    'AUTH_NOT_CONFIGURED',
  )
}

/** Warning for a loopback bind with no auth plugin. Empty unless that is the case. */
export function httpAuthLoopbackWarning(config: BreadConfig, bindHost: string): string {
  if (hasAuthPlugin(config) || !isLoopbackHostname(bindHost)) return ''
  return (
    '[bread] HTTP routes allow any caller on a loopback bind when no auth plugin is registered. ' +
    'A reverse proxy on the same machine can forward public traffic and present Host localhost, ' +
    '127.0.0.1, or [::1], so the exemption is not a network boundary. ' +
    'See docs/auth.md#guarding-the-server.'
  )
}
