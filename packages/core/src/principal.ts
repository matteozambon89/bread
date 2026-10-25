import type { BreadStore, CheckpointRecord } from './storage/store.js'
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

// Who may see a run: its live owner when this replica runs it, otherwise the
// principal on the run's first logged crumb, agent:run:start. Resumed runs
// extend the same log, so the original start crumb still decides. A run with
// no owner follows the session rule: only the local CLI principal sees it. A
// scoped caller is refused when neither owner source exists.
export async function runVisible(
  store: Pick<BreadStore, 'getCrumbs'>,
  runId: string,
  caller: Principal | undefined,
  live?: { principal: Principal | undefined },
): Promise<boolean> {
  if (caller === undefined) return true
  if (live) return ownerVisible(live.principal, caller)
  if (!store.getCrumbs) return false
  const [first] = await store.getCrumbs(runId, { afterSeq: 0, limit: 1 })
  if (first?.type !== 'agent:run:start') return false
  return ownerVisible((first.crumb as { principal?: Principal }).principal, caller)
}

// Who may resume a checkpoint: the caller must see both the checkpoint and
// the run it suspended (runVisible on checkpoint.runId). Transports check
// this before the resumed stream registers any runId, because a pipeline
// resume reuses the original step ids. The entries registered afterwards carry
// the checkpoint's principal, the original owner, never the resumer's. A
// missing checkpoint is not visible to a scoped caller.
export async function resumeVisible(
  store: Pick<BreadStore, 'getCrumbs'>,
  checkpoint: Pick<CheckpointRecord, 'runId' | 'principal'> | null | undefined,
  caller: Principal | undefined,
  live?: { principal: Principal | undefined },
): Promise<boolean> {
  if (caller === undefined) return true
  if (!checkpoint || !principalVisible(checkpoint.principal, caller)) return false
  return runVisible(store, checkpoint.runId, caller, live)
}

function ownerVisible(owner: Principal | undefined, caller: Principal): boolean {
  return owner === undefined ? isLocalCliPrincipal(caller) : principalVisible(owner, caller)
}
