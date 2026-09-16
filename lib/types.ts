import type { ProviderId } from "./providers/types";

export interface AccountTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
}

export type AccountCredentialKind = "long_lived" | "rotating" | "managed";

export interface StoredAccount {
  id: string; // verified provider account id, or a privacy-safe local id when profile is unavailable
  email: string;
  fullName?: string;
  label?: string; // user-provided nickname
  plan: string; // "Max 20×", "Max 5×", "Pro", "ChatGPT Pro", …
  addedAt: number;
  credentialKind?: AccountCredentialKind;
  // Which provider owns this account. Absent ≡ "anthropic" (back-compat: only stamped for others).
  provider?: ProviderId;
  // External source; tokens.accessToken holds its admin key, never an upstream credential.
  sub2api?: { baseUrl: string; accountId: number };
  tokens: AccountTokens;
}

// Browser-safe projection of a stored account. Credentials remain exclusively in the encrypted
// server vault; the UI receives only the non-secret metadata it needs to render account cards.
export interface BrowserAccount {
  id: string;
  email: string;
  fullName?: string;
  label?: string;
  plan: string;
  addedAt: number;
  credentialKind: AccountCredentialKind;
  provider: ProviderId; // always projected (defaults to "anthropic") so the UI can render a badge
  source?: "sub2api";
  credentialExpiresAt: number;
}

// Authenticated browser edits are deliberately semantic. They identify the server-owned account
// and the exact display fields being changed, so a stale tab can never post an old credential back.
export type VaultMutation =
  | { op: "remove"; accountId: string }
  | { op: "rename"; accountId: string; label: string | null }
  | {
      op: "update_metadata";
      accountId: string;
      email?: string;
      fullName?: string | null;
      plan?: string;
    };

export interface UsageBucket {
  utilization: number | null;
  resets_at: string | null;
}

export interface LimitScope {
  model?: { id: string | null; display_name: string | null } | null;
  surface?: string | null;
}

export type LimitSeverity = "normal" | "elevated" | "warning" | "critical" | string;

export interface LimitEntry {
  kind: string; // "session" | "weekly_all" | "weekly_scoped" | …
  group?: string | null;
  percent: number;
  severity: LimitSeverity;
  resets_at: string | null;
  scope?: LimitScope | null;
  is_active?: boolean;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
  decimal_places: number | null;
}

export interface SpendInfo {
  used?: { amount_minor: number; currency: string; exponent: number } | null;
  limit?: unknown;
  percent?: number | null;
  severity?: string | null;
  enabled?: boolean;
}

export interface UsageData {
  snapshot?: { source: "sub2api"; sampledAt: string | null; refreshCompletedAt?: number };
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  seven_day_oauth_apps?: UsageBucket | null;
  limits?: LimitEntry[] | null;
  extra_usage?: ExtraUsage | null;
  spend?: SpendInfo | null;
  [key: string]: unknown;
}

export interface ProfileData {
  account?: {
    uuid?: string;
    full_name?: string;
    display_name?: string;
    email?: string;
    has_claude_max?: boolean;
    has_claude_pro?: boolean;
  } | null;
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
    subscription_status?: string;
  } | null;
  [key: string]: unknown;
}

export interface UsageResponse {
  usage: UsageData | null;
  profile: ProfileData | null;
  // Coalesced-path fields (see lib/usage-service): the server's cache/cooldown verdict for this
  // account. `status` "reauth" means the token is dead; `stale` means we're serving the last-good
  // reading because upstream is in cooldown (rate-limited) rather than a live fetch.
  status?: "ready" | "reauth" | "stale" | "error" | "loading";
  stale?: boolean;
  cooldownUntil?: number;
  fetchedAt?: number;
}

export type SnapshotStatus = "idle" | "loading" | "ready" | "error" | "reauth";

export interface AccountSnapshot {
  status: SnapshotStatus;
  usage?: UsageData;
  profile?: ProfileData | null;
  error?: string;
  fetchedAt?: number;
  // True when the shown data is the last-good reading during an upstream cooldown (rate-limited),
  // rather than a fresh fetch. Drives the "showing last update from <time>" banner.
  stale?: boolean;
  cooldownUntil?: number;
}
