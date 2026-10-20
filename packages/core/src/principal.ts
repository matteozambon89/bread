import type { Principal } from './types.js'

// Shared by bread chat, bread invoke, and unauthenticated loopback HTTP runs.
export const LOCAL_CLI_PRINCIPAL: Principal = {
  iss: 'https://bread.local/cli',
  sub: 'local',
}

export function isLocalCliPrincipal(principal: Principal | undefined): principal is Principal {
  return principal?.iss === LOCAL_CLI_PRINCIPAL.iss && principal.sub === LOCAL_CLI_PRINCIPAL.sub
}

// Auth without a principal never reaches a run route. A missing caller is an
// unauthenticated loopback run and shares the CLI principal.
export function principalOrLocalCli(caller: Principal | undefined): Principal {
  return caller ?? LOCAL_CLI_PRINCIPAL
}

// A missing caller is unscoped. A caller matches iss and sub only — tenant is
// not an ownership key. An unstamped row stays hidden from a caller. Claiming
// that row is a separate step and is not a match here.
export function principalVisible(stored: Principal | undefined, caller: Principal | undefined): boolean {
  if (caller === undefined) return true
  if (stored === undefined) return false
  return stored.iss === caller.iss && stored.sub === caller.sub
}
