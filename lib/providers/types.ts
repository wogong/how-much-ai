// The provider abstraction. Every credential path (connect, refresh, usage) dispatches through a
// `Provider` chosen by `StoredAccount.provider`. Anthropic is the default and is wrapped by a thin
// adapter over the existing `lib/anthropic.ts`; OpenAI (ChatGPT/Codex) is a full implementation.
// See docs/provider-research.md for the endpoints and docs/superpowers/specs for the design.

import type { AccountTokens, UsageData } from "../types";

export type ProviderId = "anthropic" | "openai";

export const DEFAULT_PROVIDER: ProviderId = "anthropic";

// A provider-agnostic HTTP-ish error. Mirrors the shape the usage-service already relies on for
// Anthropic (`AnthropicError.status`), so the coalesced fetch/refresh machinery can classify
// hard-rejects (400/401/403/404) and throttling (429) uniformly across providers.
export class ProviderError extends Error {
  readonly status: number;
  readonly providerId?: ProviderId;

  constructor(message: string, status: number, providerId?: ProviderId) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.providerId = providerId;
  }
}

// The HTTP status carried by either an AnthropicError or a ProviderError (both expose `.status`),
// or undefined for a plain/network error. Lets shared code branch on status without knowing which
// provider raised it.
export function httpStatusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return undefined;
}

// Normalized identity resolved at connect time. `id` is the stable dedupe key (Anthropic account
// uuid / ChatGPT account id); `plan` is the already-formatted display label.
export interface ProviderProfile {
  id: string;
  email: string;
  fullName?: string;
  plan: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string; // human name for the picker/badge, e.g. "Claude", "ChatGPT / Codex"
  // True when this provider supports the in-app OAuth PKCE "private login" connect method.
  readonly supportsOAuth: boolean;
  readonly managesCredentialsExternally?: boolean;

  // Refresh a (rotating) credential. Throws AnthropicError/ProviderError with a `.status` on failure;
  // single-use refresh tokens must never be retried by the provider itself. `opts.scopes` lets the
  // caller request a specific scope set (Anthropic uses it for app-owned "managed" logins); providers
  // that don't need it ignore it.
  refresh(tokens: AccountTokens, opts?: { scopes?: string }): Promise<AccountTokens>;

  // Fetch normalized subscription usage. Throws with a `.status` on non-2xx / unusable responses.
  fetchUsage(tokens: AccountTokens, opts?: { activeRefresh?: boolean }): Promise<UsageData>;

  // Resolve identity + plan from a credential (network or token-decode). Used by the connect flow.
  resolveIdentity(tokens: AccountTokens): Promise<ProviderProfile>;

  // One-click read of THIS machine's credential for this provider (self-hosted "local" connect).
  readLocalCredential?(deps?: unknown): Promise<AccountTokens>;

  // Parse a pasted credential blob into tokens (manual connect). Returns null when unrecognized.
  parseManualCredential?(raw: string): AccountTokens | null;
}
