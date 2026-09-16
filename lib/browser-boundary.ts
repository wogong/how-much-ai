import type { AccountUsageResult } from "./usage-service";
import type { BrowserAccount, ProfileData, StoredAccount, UsageData, UsageResponse } from "./types";

export interface BrowserUsageResponse extends UsageResponse {
  error?: string;
}

function withoutCredentialFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => withoutCredentialFields(entry)) as T;
  if (!value || typeof value !== "object") return value;

  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (normalized === "accesstoken" || normalized === "refreshtoken") continue;
    clean[key] = withoutCredentialFields(entry);
  }
  return clean as T;
}

export function toBrowserAccount(account: StoredAccount): BrowserAccount {
  return {
    id: account.id,
    email: account.email,
    ...(account.fullName !== undefined ? { fullName: account.fullName } : {}),
    ...(account.label !== undefined ? { label: account.label } : {}),
    plan: account.plan,
    addedAt: account.addedAt,
    credentialKind:
      account.credentialKind ?? (account.tokens.refreshToken === null ? "long_lived" : "rotating"),
    provider: account.provider ?? "anthropic",
    ...(account.sub2api ? { source: "sub2api" as const } : {}),
    credentialExpiresAt: account.tokens.expiresAt,
  };
}

export function toBrowserAccounts(accounts: readonly StoredAccount[]): BrowserAccount[] {
  return accounts.map(toBrowserAccount);
}

// Deliberately allowlist every top-level usage field. AccountUsageResult contains an internal
// rotated-token recovery pair on exceptional paths; it must never cross the browser boundary.
export function toBrowserUsageResponse(result: AccountUsageResult): BrowserUsageResponse {
  return {
    usage: result.usage ? withoutCredentialFields<UsageData>(result.usage) : null,
    profile: result.profile ? withoutCredentialFields<ProfileData>(result.profile) : null,
    status: result.status,
    stale: result.stale,
    cooldownUntil: result.cooldownUntil,
    ...(result.fetchedAt !== null ? { fetchedAt: result.fetchedAt } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}
