// 0.1.x names. providerCatalog is the same registry as providerLlm; dropping
// either name is a break inside >=0.1.0 <1.0.0.
export {
  providerEntries,
  providerLlm,
  providerLlm as providerCatalog,
  type CatalogEntry,
} from '@breadai/provider-llm'
