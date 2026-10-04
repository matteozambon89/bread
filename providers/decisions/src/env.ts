import { BreadError } from '@breadai/core'

export function envValue(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return undefined
  return value
}

export function requireEnv(provider: string, names: readonly string[]): Record<string, string> {
  const unset = names.filter((name) => envValue(name) === undefined)
  if (unset.length > 0) {
    throw new BreadError(
      `Decision provider "${provider}" is not configured. Missing env vars: ${unset.join(', ')}`,
      'PROVIDER_NOT_CONFIGURED',
      { provider, unset },
    )
  }
  return Object.fromEntries(names.map((name) => [name, envValue(name)!]))
}
