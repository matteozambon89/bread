import { describe, expect, test } from 'bun:test'
import {
  providerCatalog,
  providerEntries as catalogEntries,
  providerLlm as catalogLlm,
  type CatalogEntry,
} from '@breadai/provider-catalog'
import { providerEntries, providerLlm } from '@breadai/provider-llm'

describe('@breadai/provider-catalog', () => {
  test('re-exported keys match @breadai/provider-llm', () => {
    expect(providerCatalog).toBe(providerLlm)
    expect(catalogLlm).toBe(providerLlm)
    expect(Object.keys(catalogLlm).sort()).toEqual(Object.keys(providerLlm).sort())
    expect(Object.keys(catalogEntries).sort()).toEqual(Object.keys(providerEntries).sort())
  })

  test('keeps the 0.1.x CatalogEntry type', () => {
    const openai = catalogEntries.openai
    expect(openai).toBeDefined()
    const entry: CatalogEntry = openai!
    expect(entry.pkg).toBe(providerEntries.openai?.pkg)
    expect(entry.export).toBe(providerEntries.openai?.export)
  })
})
