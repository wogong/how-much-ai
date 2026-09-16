// Provider registry. `getProvider` dispatches by `StoredAccount.provider`, defaulting to Anthropic so
// pre-existing vault records (which predate the provider field) keep working unchanged.

import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { DEFAULT_PROVIDER, type Provider, type ProviderId } from "./types";
import { sub2ApiProvider } from "../sub2api";
import type { StoredAccount } from "../types";

export { DEFAULT_PROVIDER, ProviderError, httpStatusOf } from "./types";
export type { Provider, ProviderId, ProviderProfile } from "./types";

// Order is UI-significant (provider picker order).
export const PROVIDERS: readonly Provider[] = [anthropicProvider, openaiProvider];

const BY_ID: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function isProviderId(id: unknown): id is ProviderId {
  return id === "anthropic" || id === "openai";
}

export function getProvider(id?: string | null): Provider {
  return isProviderId(id) ? BY_ID[id] : BY_ID[DEFAULT_PROVIDER];
}

export function getAccountProvider(account: StoredAccount): Provider {
  const provider = getProvider(account.provider);
  return account.sub2api ? sub2ApiProvider(provider, account.sub2api) : provider;
}
