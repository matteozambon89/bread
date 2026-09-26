import { BreadError } from '@breadai/core'
import { providerEntries } from '@breadai/provider-catalog'

export function assertKnownProvider(name: string): string {
  const provider = name.trim()
  if (provider === '') {
    throw new BreadError(
      'Missing --provider. Pass --provider. There is no default. Nothing was written.',
      'SCAFFOLD_INVALID_NAME',
    )
  }
  // Inherited names (constructor, toString, __proto__) are not catalog providers.
  if (!Object.hasOwn(providerEntries, provider)) {
    const available = Object.keys(providerEntries).sort().join(', ')
    throw new BreadError(`Unknown provider "${provider}". Available: ${available}`, 'UNKNOWN_PROVIDER', {
      name: provider,
    })
  }
  return provider
}

export function assertModelId(model: string): string {
  const id = model.trim()
  if (id === '') {
    throw new BreadError(
      'Missing --model. Pass --model. There is no default. Nothing was written.',
      'SCAFFOLD_INVALID_NAME',
    )
  }
  return id
}
