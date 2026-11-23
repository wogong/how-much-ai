// Pure decision logic for the shared usage cache + single-flight refresh lock.
//
// This module has NO I/O — no Convex, no fetch, no node APIs — so it is unit-testable in
// isolation (see usage-cache-core.test.ts) and safe to import from anywhere. The Convex
// mutation in convex/usageCache.ts mirrors `claimDecision` by hand (Convex modules and the
// Next app don't share a module graph), so the tested rule and the transactional lock agree.
//
// Why this exists: Anthropic refresh tokens are single-use and rotate on every refresh. The
// dashboard (per-minute) and the Convex cron (5-minute) both poll the same account, so without
// coordination they RACE the single-use token — the loser sends the now-dead token and Anthropic
// answers 429 rate_limit_error (an obfuscated auth rejection with no Retry-After that sticks for
// 30+ minutes under a retry-storm). The cache TTL coalesces reads; the CAS lock guarantees only
// one holder ever refreshes the token at a time.

export const CACHE_TTL_MS = 300_000; // 5 min — within this, reads are served from cache (no upstream).
export const REFRESH_LOCK_MS = 120_000; // 2 min lease, renewed by the active holder during slower upstream calls.
export const COOLDOWN_MS = 15 * 60_000; // 15 min — back off upstream after a hard rejection (dead token / 429).
export const TOKEN_SKEW_MS = 60_000; // refresh the access token only when it expires within 60 s.

export interface CacheEntry {
  hasUsage: boolean; // whether a usage payload is present to serve
  fetchedAt: number; // epoch ms of the last successful upstream fetch (0 = never)
  status: string; // "ready" | "reauth" | "stale" | …
  cooldownUntil: number; // epoch ms; > now ⇒ do NOT hit upstream, serve stale
  refreshingUntil: number; // epoch ms; > now ⇒ a holder currently owns the single-flight lock
}

export type CacheAction = "fresh" | "cooldown" | "fetch";

// External keys can become valid again without reconnecting; rotating logins cannot be retried safely.
export function isUsageRetryBlocked(
  entry: { status?: string; cooldownUntil?: number } | null | undefined,
  now: number,
  externallyManaged = false,
): boolean {
  return (entry?.status === "reauth" && !externallyManaged) || (entry?.cooldownUntil ?? 0) > now;
}

// What should a reader do with the current cache entry?
//   fresh    → recent successful data; return it as-is (fast path, no upstream call).
//   cooldown → stale data but we're in an upstream back-off; return it flagged stale, no upstream.
//   fetch    → go to upstream (the caller then contends for the single-flight lock).
// Fresh is checked first so a just-refreshed account is never mislabeled stale by a lingering
// cooldown; in practice the two are mutually exclusive (a failure that sets cooldown never
// advances fetchedAt).
export function decideCacheAction(entry: CacheEntry | null, now: number, ttlMs = CACHE_TTL_MS): CacheAction {
  if (entry) {
    if (entry.hasUsage && now - entry.fetchedAt < ttlMs) return "fresh";
    if (entry.cooldownUntil > now) return "cooldown";
  }
  return "fetch";
}

// decideCacheAction, but aware of the account's current tokens. A reauth cooldown exists because a
// token was DEAD — so a currently-valid access token proves the account was since reconnected, and we
// heal immediately ("fetch") instead of serving "re-add this account" for the rest of the cooldown.
// Only reauth cooldowns are bypassed: a stale/error cooldown (usage endpoint 429) is a real upstream
// back-off where the token being valid changes nothing.
export function decideCacheActionWithTokens(
  entry: CacheEntry | null,
  now: number,
  tokensValid: boolean,
  ttlMs = CACHE_TTL_MS,
): CacheAction {
  const base = decideCacheAction(entry, now, ttlMs);
  if (base === "cooldown" && entry?.status === "reauth" && tokensValid) return "fetch";
  return base;
}

// Does the access token need refreshing before we use it? Only within the skew window, to keep
// single-use-token rotations as rare as possible (≈ once per ~8 h token lifetime).
export function needsRefresh(
  tokens: { accessToken: string | null | undefined; refreshToken?: string | null; expiresAt: number },
  now: number,
  skewMs = TOKEN_SKEW_MS,
): boolean {
  if (!tokens.accessToken) return true;
  // Dedicated `claude setup-token` credentials are one-year bearer tokens and intentionally have
  // no rotating refresh token. Use them directly until upstream actually returns 401.
  if (tokens.refreshToken === null) return false;
  return tokens.expiresAt < now + skewMs;
}

// Compare-and-set for the single-flight refresh lock. A lock strictly in the future is held by
// another holder → do not acquire. Otherwise take it and stamp it now+lockMs. The Convex mutation
// applies this exact rule inside a transaction, which is what actually serializes the refresh.
export function claimDecision(
  entry: { refreshingUntil: number } | null,
  now: number,
  lockMs = REFRESH_LOCK_MS,
): { acquired: boolean; refreshingUntil: number } {
  if (entry && entry.refreshingUntil > now) {
    return { acquired: false, refreshingUntil: entry.refreshingUntil };
  }
  return { acquired: true, refreshingUntil: now + lockMs };
}

// The cache patch to apply after a refresh is explicitly hard-rejected (400/401/403/404).
// Mark the account reauth and cool down upstream for 15 min so the client surfaces "re-add this
// account" instead of retry-storming a rejection that would otherwise stick for 30+ minutes.
export function reauthPatch(now: number, cooldownMs = COOLDOWN_MS): { status: "reauth"; cooldownUntil: number } {
  return { status: "reauth", cooldownUntil: now + cooldownMs };
}
