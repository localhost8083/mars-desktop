// MarsAI-only GUI: every model comes from the MarsAI gateway (the `mars`
// embedded provider and org-assigned LPR providers). No direct provider is
// offered for configuration.
const DIRECT_PROVIDER_IDS: readonly string[] = [];

const directProviderSet = new Set<string>(DIRECT_PROVIDER_IDS);

export function isInternalModelProvider(providerID: string) {
  const normalized = providerID.trim().toLowerCase();
  return normalized === "mars" || /^lpr_/.test(normalized);
}

export function isDirectModelProvider(providerID: string) {
  return directProviderSet.has(providerID.trim().toLowerCase());
}

// Model pickers list only marsai.click (and org-assigned) models, which come
// from the account's catalog. Providers from the user's own engine config
// (their OpenAI, Anthropic, … keys) come back with
// VITE_MARS_ALLOW_OTHER_PROVIDERS=1 at build time.
const OTHER_PROVIDERS_ALLOWED = import.meta.env.VITE_MARS_ALLOW_OTHER_PROVIDERS === "1";

export function isSupportedModelProvider(providerID: string, allowOtherProviders = OTHER_PROVIDERS_ALLOWED) {
  return isInternalModelProvider(providerID) || (allowOtherProviders && isDirectModelProvider(providerID));
}

export function providerCatalogRank(providerID: string) {
  const normalized = providerID.trim().toLowerCase();
  if (isInternalModelProvider(normalized)) return 0;
  const directIndex = DIRECT_PROVIDER_IDS.findIndex((providerID) => providerID === normalized);
  return directIndex < 0 ? Number.MAX_SAFE_INTEGER : directIndex + 1;
}
