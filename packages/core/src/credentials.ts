import { BreadError, type CredentialProvider, type VaultOpts } from './types.js'

export function envProvider(): CredentialProvider {
  return {
    async get(name: string): Promise<string | undefined> {
      return process.env[name]
    },
  }
}

// Vault's HTTP API has no separate parameter for the secret name or mount — both are path
// segments interpolated directly into the request URL (`/v1/{mount}/data/{name}`). Restrict both
// to a conservative charset so a name/mount can't redirect the request to a different path (e.g.
// "../other-mount/x") or inject URL-meaningful characters ("?", "#", "%", "/", whitespace, ...).
const VAULT_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

function assertVaultSegment(kind: 'credential name' | 'vault mount', value: string): void {
  if (!VAULT_SEGMENT_RE.test(value)) {
    throw new BreadError(
      `${kind} "${value}" must match ${VAULT_SEGMENT_RE} (letters, digits, "_", "-", starting ` +
        'with a letter) to be used safely as a Vault request path segment',
      kind === 'credential name' ? 'INVALID_CREDENTIAL_NAME' : 'INVALID_VAULT_MOUNT',
      { kind, value },
    )
  }
}

export function vaultProvider(opts: VaultOpts): CredentialProvider {
  const mount = opts.mount ?? 'secret'
  assertVaultSegment('vault mount', mount)
  return {
    async get(name: string): Promise<string | undefined> {
      assertVaultSegment('credential name', name)
      const res = await fetch(`${opts.address}/v1/${mount}/data/${name}`, {
        headers: { 'X-Vault-Token': opts.token },
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { data?: { data?: Record<string, string> } }
      return body.data?.data?.[name]
    },
  }
}

// Scopes a provider to the names a tool declared in `ToolDefinition.credentials`. Secure by
// default: an undeclared or empty allowlist rejects every name, forcing tools to opt in
// explicitly rather than silently inheriting unscoped access to the base provider.
export function scopedProvider(base: CredentialProvider, allowed: string[] | undefined): CredentialProvider {
  return {
    async get(name: string): Promise<string | undefined> {
      if (!allowed?.includes(name)) {
        throw new BreadError(
          `credential "${name}" was not declared in this tool's \`credentials\` array`,
          'CREDENTIAL_NOT_DECLARED',
          { name, allowed: allowed ?? [] },
        )
      }
      return base.get(name)
    },
  }
}
