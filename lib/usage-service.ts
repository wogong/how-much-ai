// The single coalesced path both the dashboard (/api/usage) and the cron (/api/cron/check) use to
// read an account's usage. It is what fixes the single-use-token race:
//
//   1. A shared per-account cache (300 s TTL) coalesces the two pollers so upstream is hit at most
//      once per 5 min per account — no 3-min hammer.
//   2. A single-flight refresh LOCK (compare-and-set on usageCache.refreshingUntil, applied inside a
//      transactional Convex mutation) guarantees only ONE caller ever refreshes an account's
//      single-use token at a time. The loser serves cached data instead of double-spending the token.
//   3. The token refresh happens INSIDE that lock, using the freshest token (vault copy supersedes a
//      caller's stale one). On success the rotated pair is persisted to the vault immediately. On a
//      confirmed hard rejection (400/401/403/404) we mark the account "reauth" and cool down upstream for
//      15 min — we never retry-storm a rejection that would otherwise stick for 30+ minutes.
//
// Convex and Redis/KV both provide cross-instance owner-fenced leases. File-backed self-hosting
// degrades to an in-process module cache + single-flight map, which is sufficient for its normal
// single-process deployment.

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { scopedKey } from "./app-config";
import {
  AnthropicError,
  CLAUDE_SUBSCRIPTION_OAUTH,
  fetchProfile,
  fetchUsage,
  isProfilePermissionError,
} from "./anthropic";
import { getAccountProvider, httpStatusOf } from "./providers/index";
import {
  createRedisUsageCacheFromConfig,
  redisUsageConfig,
  type RedisRestConfig,
  type RedisUsageCacheRow,
} from "./redis-usage-cache";
import {
  clearTokenRecovery,
  loadAccounts,
  loadTokenRecovery,
  mutateAccounts,
  saveTokenRecovery,
} from "./vault";
import { withLocalUsageRefreshLock } from "./local-file-lock";
import { readLocalReplacementTokens } from "./local-credential-heal";
import {
  decideCacheAction,
  needsRefresh,
  reauthPatch,
  CACHE_TTL_MS,
  COOLDOWN_MS,
  REFRESH_LOCK_MS,
  type CacheEntry,
  type CacheAction,
} from "./usage-cache-core";
import type { AccountTokens, ProfileData, StoredAccount, UsageData } from "./types";

export type AccountUsageStatus = "ready" | "reauth" | "stale" | "error" | "loading";

export interface AccountUsageResult {
  usage: UsageData | null;
  profile: ProfileData | null;
  status: AccountUsageStatus;
  fetchedAt: number | null;
  cooldownUntil: number;
  stale: boolean;
  error?: string;
  tokens?: AccountTokens; // rotated pair; normally already durable, echoed only to keep this tab current
  // Present only when renewal succeeded but every durable vault write failed. Normal rotated pairs
  // are already saved server-side and must not trigger a redundant browser whole-vault write.
  tokensNeedPersistence?: true;
}

// Per-(tenant, account) cache key. The self-hosted API uses the historical `default` tenant, so its
// keys remain bare and existing caches continue to work. Account ids are UUIDs, so `usage:<id>` is
// unambiguous.
export function usageCacheKey(userId: string, accountId: string): string {
  return scopedKey(`usage:${accountId}`, userId);
}

function convexConfig(): { url: string; secret: string } | null {
  const url = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.VAULT_ACCESS_SECRET;
  return url && secret ? { url, secret } : null;
}

// A raw cache row, as stored (usage/profile are opaque JSON strings, or null).
interface CacheRow {
  usage: string | null;
  profile: string | null;
  fetchedAt: number;
  status: string;
  cooldownUntil: number;
  refreshingUntil: number;
  refreshOwner?: string;
}

function rowToEntry(row: CacheRow | null): CacheEntry | null {
  if (!row) return null;
  return {
    hasUsage: row.usage != null,
    fetchedAt: row.fetchedAt,
    status: row.status,
    cooldownUntil: row.cooldownUntil,
    refreshingUntil: row.refreshingUntil,
  };
}

function coordinatedCacheAction(entry: CacheEntry | null, now: number, activeRefresh = false, usage?: UsageData | null): CacheAction {
  // Reauth is terminal until an explicit reconnect clears this account's cache state. Treating a
  // rejected token as valid merely because its timestamp is in the future would restart rotation.
  if (entry?.status === "reauth") return "cooldown";
  if (activeRefresh) {
    // Manual sub2api reads bypass passive cache freshness, never leases or backoff.
    if (entry && entry.cooldownUntil > now) return "cooldown";
    const completedAt = usage?.snapshot?.refreshCompletedAt;
    if (entry?.hasUsage && completedAt && now >= completedAt && now - completedAt < 10_000) return "fresh";
    return "fetch";
  }
  return decideCacheAction(entry, now);
}

function parseJson<T>(s: string | null | undefined): T | null {
  if (s == null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to reach Anthropic";
}

// Only an explicit auth rejection from token refresh proves the grant is dead/revoked. A 429 is
// ambiguous throttling and must remain recoverable, so it cools down without forcing reconnect.
// 5xx/network is also transient — release the lock and try again on a later poll.
function isHardAuthReject(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status !== undefined && [400, 401, 403, 404].includes(status);
}

// Some access-only credentials may expose usage while withholding the identity-only profile scope.
// Suppress only Anthropic's structured 403 for that exact optional profile request; the usage call
// itself remains authoritative and current inference-only setup tokens fail there with clear copy.
async function fetchProfileForCredential(tokens: AccountTokens): Promise<ProfileData | null> {
  try {
    return await fetchProfile(tokens.accessToken);
  } catch (error) {
    if (tokens.refreshToken === null && isProfilePermissionError(error)) return null;
    throw error;
  }
}

// The freshest token the vault holds for this account (rotated by another poller, perhaps). null
// when the account isn't in the vault yet (e.g. the add-account flow, before the first save).
async function currentVaultTokens(userId: string, accountId: string): Promise<AccountTokens | null> {
  const accounts = await loadAccounts(userId);
  return accounts.find((a) => a.id === accountId)?.tokens ?? null;
}

export class RotatedTokenPersistenceError extends Error {
  readonly tokens: AccountTokens;

  constructor(tokens: AccountTokens, cause?: unknown) {
    super("Automatic token renewal succeeded, but the rotated credential could not be saved.", { cause });
    this.name = "RotatedTokenPersistenceError";
    this.tokens = tokens;
  }
}

function sameTokens(a: AccountTokens | undefined, b: AccountTokens): boolean {
  return Boolean(
    a &&
      a.accessToken === b.accessToken &&
      a.refreshToken === b.refreshToken &&
      a.expiresAt === b.expiresAt,
  );
}

// A refresh token is single-use: once Anthropic returns its replacement, losing that replacement
// permanently strands the account. Therefore persistence is REQUIRED, not best-effort. Retry
// transient storage/CAS faults and verify the exact rotated pair before any ready result is exposed.
async function persistAccountTokens(
  userId: string,
  accountId: string,
  expectedRefreshToken: string,
  tokens: AccountTokens,
): Promise<AccountTokens> {
  const delays = [0, 100, 350, 1_000, 2_500];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      let presentOnAttempt = false;
      await mutateAccounts(userId, (latest) => {
        const current = latest.find((account) => account.id === accountId);
        presentOnAttempt = Boolean(current);
        if (!current) return latest;
        if (sameTokens(current.tokens, tokens)) return latest;
        // Another refresh already advanced the chain. Never write our older generation back over
        // it; the caller will adopt the authoritative vault pair after verification below.
        if (current.tokens.refreshToken !== expectedRefreshToken) return latest;
        return latest.map((account) => (account.id === accountId ? { ...account, tokens } : account));
      });
      if (!presentOnAttempt) throw new Error("The account was removed while its token was renewing.");
      const saved = (await loadAccounts(userId)).find((account) => account.id === accountId)?.tokens;
      if (sameTokens(saved, tokens)) return tokens;
      if (saved && saved.refreshToken !== expectedRefreshToken) return saved;
      throw new Error("The vault did not retain the rotated credential.");
    } catch (error) {
      lastError = error;
    }
  }
  throw new RotatedTokenPersistenceError(tokens, lastError);
}

// Abstracts the two backends: commit writes the outcome AND releases the lock; release just frees the
// lock (error paths). Fields left undefined on commit preserve the prior stored value.
interface CacheStore {
  commit(o: {
    usage?: UsageData;
    profile?: ProfileData | null;
    fetchedAt?: number;
    status: string;
    cooldownUntil: number;
  }): Promise<void>;
  release(): Promise<void>;
}

interface Prior {
  usage: UsageData | null;
  profile: ProfileData | null;
  fetchedAt: number | null;
  status: string | null;
}

const LEGACY_REFRESH_THROTTLE_REAUTH_AFTER = 3;

function nextRefreshThrottleCount(status: string | null): number {
  const match = /^refresh_throttled_(\d+)$/.exec(status ?? "");
  return (match ? Number(match[1]) : 0) + 1;
}

function reauthResult(now: number, prior: Prior, err?: unknown): AccountUsageResult {
  return {
    usage: prior.usage,
    profile: prior.profile,
    status: "reauth",
    fetchedAt: prior.fetchedAt,
    cooldownUntil: now + COOLDOWN_MS,
    stale: true,
    error: err ? errMsg(err) : undefined,
  };
}

function staleResult(now: number, prior: Prior): AccountUsageResult {
  return {
    usage: prior.usage,
    profile: prior.profile,
    status: prior.usage ? "stale" : "error",
    fetchedAt: prior.fetchedAt,
    cooldownUntil: now + COOLDOWN_MS,
    stale: true,
  };
}

function failedRefreshResult(prior: Prior, error: unknown): AccountUsageResult {
  if (error instanceof RotatedTokenPersistenceError) {
    return {
      usage: prior.usage,
      profile: prior.profile,
      status: "error",
      fetchedAt: prior.fetchedAt,
      cooldownUntil: 0,
      stale: true,
      tokens: error.tokens,
      tokensNeedPersistence: true,
      error:
        "Claude renewed this account, but the new credential could not be saved after several attempts. Keep this dashboard open and retry; do not reconnect yet.",
    };
  }
  if (prior.usage) return { ...staleResult(Date.now(), prior), cooldownUntil: 0, error: errMsg(error) };
  return {
    usage: null,
    profile: null,
    status: "error",
    fetchedAt: null,
    cooldownUntil: 0,
    stale: true,
    error: errMsg(error),
  };
}

// The heart of the fetch path — runs only while the caller OWNS the single-flight lock. It always
// either commits (which releases the lock) or throws (the caller releases). `prior` is the last-good
// data, kept so a reauth/stale outcome still surfaces the previous reading.
async function refreshAndFetch(
  userId: string,
  account: StoredAccount,
  now: number,
  store: CacheStore,
  prior: Prior,
  activeRefresh = false,
): Promise<AccountUsageResult> {
  // This function is used only for already-connected accounts. The server vault is authoritative;
  // browser-posted credentials can be blank, hours stale, or already spent and must never influence
  // which single-use refresh generation the lease owner uses.
  const provider = getAccountProvider(account);
  let tokens = (await currentVaultTokens(userId, account.id)) ?? account.tokens;
  let rotated = false;

  // A prior process may have received R1 but failed while replacing R0 in the main vault. Adopt the
  // encrypted recovery record before making any upstream call; retrying R0 would spend a dead grant.
  if (tokens.refreshToken) {
    const recovery = await loadTokenRecovery(userId, account.id);
    if (recovery) {
      tokens = await persistAccountTokens(
        userId,
        account.id,
        recovery.record.expectedRefreshToken,
        recovery.record.tokens,
      );
      rotated = true;
      await clearTokenRecovery(userId, account.id, recovery).catch(() => false);
    }
  }

  const doRefresh = async (force = false): Promise<AccountUsageResult | null> => {
    const base = (await currentVaultTokens(userId, account.id)) ?? tokens;
    if (!force && !needsRefresh(base, Date.now())) {
      tokens = base;
      return null;
    }
    if (provider.managesCredentialsExternally || !base.refreshToken) {
      const { status, cooldownUntil } = reauthPatch(now);
      await store.commit({ status, cooldownUntil });
      return reauthResult(now, prior, provider.managesCredentialsExternally
        ? new Error("sub2api rejected the admin key. Reconnect sub2api.") : undefined);
    }
    try {
      const refreshed = await provider.refresh(
        base,
        account.credentialKind === "managed" ? { scopes: CLAUDE_SUBSCRIPTION_OAUTH.scopes } : undefined,
      );
      rotated = true;
      let journalError: unknown;
      let journalGeneration: Awaited<ReturnType<typeof saveTokenRecovery>> | null = null;
      try {
        journalGeneration = await saveTokenRecovery(
          {
            accountId: account.id,
            expectedRefreshToken: base.refreshToken,
            tokens: refreshed,
            createdAt: Date.now(),
          },
          userId,
        );
      } catch (error) {
        journalError = error;
      }
      try {
        tokens = await persistAccountTokens(userId, account.id, base.refreshToken, refreshed);
        if (journalGeneration) {
          await clearTokenRecovery(userId, account.id, journalGeneration).catch(() => false);
        }
      } catch (error) {
        if (error instanceof RotatedTokenPersistenceError && journalError) {
          throw new RotatedTokenPersistenceError(refreshed, new AggregateError([journalError, error]));
        }
        throw error;
      }
      return null; // success — caller continues
    } catch (err) {
      if (httpStatusOf(err) === 429) {
        const nextCount = nextRefreshThrottleCount(prior.status);
        const managed = account.credentialKind === "managed";
        if (!managed && nextCount >= LEGACY_REFRESH_THROTTLE_REAUTH_AFTER) {
          const { status, cooldownUntil } = reauthPatch(now);
          await store.commit({ status, cooldownUntil });
          return reauthResult(
            now,
            prior,
            new Error(
              "Automatic renewal was throttled repeatedly. Replace this shared session with the private app login.",
            ),
          );
        }
        // A managed credential has a refresh chain owned only by this app. Unlike a shared legacy
        // CLI session, repeated 429s are not evidence that another process spent the grant, so they
        // remain recoverable indefinitely. Cap only the diagnostic counter and preserve stale data
        // behind a cooldown until Anthropic either succeeds or returns an explicit hard reject.
        const throttleCount = managed
          ? Math.min(nextCount, LEGACY_REFRESH_THROTTLE_REAUTH_AFTER)
          : nextCount;
        await store.commit({ status: `refresh_throttled_${throttleCount}`, cooldownUntil: now + COOLDOWN_MS });
        return {
          ...staleResult(now, prior),
          error: managed
            ? "Automatic renewal was temporarily throttled. This private app login remains connected and will retry after a cooldown."
            : `Automatic renewal was temporarily throttled. The app will retry after a cooldown (${throttleCount}/${LEGACY_REFRESH_THROTTLE_REAUTH_AFTER}).`,
        };
      }
      if (isHardAuthReject(err)) {
        // A shared CLI login on this machine may have rotated the grant itself. Adopt its current
        // pair (same-account verified, already-issued, so nothing is spent) instead of going offline.
        const replacement = await readLocalReplacementTokens(account, base.refreshToken);
        if (replacement) {
          tokens = await persistAccountTokens(userId, account.id, base.refreshToken, replacement);
          rotated = true;
          return null;
        }
        const { status, cooldownUntil } = reauthPatch(now);
        await store.commit({ status, cooldownUntil });
        return reauthResult(now, prior, err);
      }
      throw err; // transient — release lock, retry next poll
    }
  };

  // Refresh proactively only when the access token is at/near expiry — keeps single-use rotations rare.
  // Some older CLI credential files omit expiresAt. A bearer token just verified during connection
  // should be used until its first real 401, not rotated immediately merely because metadata is absent.
  const unknownRotatingExpiry = Boolean(tokens.refreshToken) && tokens.expiresAt <= 0;
  if (!provider.managesCredentialsExternally && !unknownRotatingExpiry && needsRefresh(tokens, now)) {
    const bail = await doRefresh();
    if (bail) return bail;
  }

  let usage: UsageData;
  let profile: ProfileData | null;
  try {
    [usage, profile] = await Promise.all([
      provider.fetchUsage(tokens, { activeRefresh }),
      provider.id === "anthropic" && !provider.managesCredentialsExternally ? fetchProfileForCredential(tokens) : Promise.resolve(null),
    ]);
  } catch (err) {
    if (httpStatusOf(err) === 401 && rotated) {
      const { status, cooldownUntil } = reauthPatch(now);
      await store.commit({ status, cooldownUntil });
      return reauthResult(
        now,
        prior,
        new Error("Claude rejected the replacement access token. Reconnect with the private app login."),
      );
    }
    if (httpStatusOf(err) === 401 || (provider.managesCredentialsExternally && httpStatusOf(err) === 403)) {
      // Access token stale despite our bookkeeping — refresh once (still inside the lock) and retry.
      const bail = await doRefresh(true);
      if (bail) return bail;
      try {
        [usage, profile] = await Promise.all([
          provider.fetchUsage(tokens, { activeRefresh }),
          provider.id === "anthropic" && !provider.managesCredentialsExternally ? fetchProfileForCredential(tokens) : Promise.resolve(null),
        ]);
      } catch (retryError) {
        if (httpStatusOf(retryError) === 401) {
          const { status, cooldownUntil } = reauthPatch(now);
          await store.commit({ status, cooldownUntil });
          return reauthResult(
            now,
            prior,
            new Error("Claude rejected the replacement access token. Reconnect with the private app login."),
          );
        }
        if (httpStatusOf(retryError) === 429) {
          await store.commit({ status: prior.usage ? "stale" : "error", cooldownUntil: now + COOLDOWN_MS });
          return { ...staleResult(now, prior), error: "Usage is temporarily rate-limited after renewal." };
        }
        throw retryError;
      }
    } else if (httpStatusOf(err) === 429) {
      // The usage endpoint itself is rate-limited (per access token). The token is fine — do NOT
      // reauth. Cool down so we don't hammer, and keep serving the last-good reading as stale.
      await store.commit({ status: prior.usage ? "stale" : "error", cooldownUntil: now + COOLDOWN_MS });
      return staleResult(now, prior);
    } else {
      throw err; // unexpected — release lock, surface prior/error
    }
  }

  // Profile data contains email/name and already lives inside the encrypted vault. Do not duplicate
  // that PII into the plaintext usage-coordination cache; only the immediate caller receives it.
  await store.commit({ usage, profile: null, fetchedAt: now, status: "ready", cooldownUntil: 0 });
  return {
    usage,
    profile,
    status: "ready",
    fetchedAt: now,
    cooldownUntil: 0,
    stale: false,
    tokens: rotated ? tokens : undefined,
  };
}

function readyOrStaleResult(row: CacheRow | null, stale: boolean): AccountUsageResult {
  if (!row) {
    // No cache yet and someone else holds the lock → nothing to serve; the client keeps its skeleton.
    return { usage: null, profile: null, status: "loading", fetchedAt: null, cooldownUntil: 0, stale };
  }
  const usage = parseJson<UsageData>(row.usage);
  const refreshThrottled = row.status.startsWith("refresh_throttled_");
  const status = (
    row.status === "reauth"
      ? "reauth"
      : stale
        ? usage
          ? "stale"
          : row.status === "error" || refreshThrottled
            ? "error"
            : "loading"
        : "ready"
  ) as AccountUsageStatus;
  return {
    usage,
    profile: null,
    status,
    fetchedAt: row.fetchedAt || null,
    cooldownUntil: row.cooldownUntil,
    stale,
    ...(refreshThrottled
      ? { error: "Automatic renewal is temporarily throttled. The app will retry after its cooldown." }
      : {}),
  };
}

// --- Convex backend (bulletproof, multi-tenant) -------------------------------

async function getAccountUsageConvex(
  cx: { url: string; secret: string },
  userId: string,
  account: StoredAccount,
  activeRefresh = false,
): Promise<AccountUsageResult> {
  const client = new ConvexHttpClient(cx.url);
  const key = usageCacheKey(userId, account.id);
  const now = Date.now();
  const owner = globalThis.crypto.randomUUID();

  // Read + claim go through Convex — the coordination backend. If it's unreachable we must FAIL SAFE:
  // never refresh a single-use token without the lock (that would reopen the race). Surface a soft
  // error instead; the next poll retries once Convex is back.
  let row: CacheRow | null;
  let claim: { acquired: boolean; cached: CacheRow | null };
  try {
    row = (await client.query(anyApi.usageCache.get, { secret: cx.secret, key })) as CacheRow | null;
    const action = coordinatedCacheAction(rowToEntry(row), now, activeRefresh, parseJson<UsageData>(row?.usage));
    if (action === "fresh") return readyOrStaleResult(row, false);
    if (action === "cooldown") return readyOrStaleResult(row, true);

    // Contend for the single-flight lock (transactional CAS).
    claim = (await client.mutation(anyApi.usageCache.claim, { secret: cx.secret, key, owner })) as {
      acquired: boolean;
      cached: CacheRow | null;
    };
  } catch (err) {
    return { usage: null, profile: null, status: "error", fetchedAt: null, cooldownUntil: 0, stale: true, error: errMsg(err) };
  }
  if (!claim.acquired) {
    // Someone else is refreshing — serve cached instead of a second upstream call.
    return readyOrStaleResult(claim.cached ?? row, true);
  }

  if (activeRefresh) {
    const action = coordinatedCacheAction(rowToEntry(claim.cached), Date.now(), true, parseJson<UsageData>(claim.cached?.usage));
    if (action !== "fetch") {
      await client.mutation(anyApi.usageCache.release, { secret: cx.secret, key, owner }).catch(() => {});
      return readyOrStaleResult(claim.cached, action === "cooldown");
    }
    row = claim.cached ?? row;
  }

  let renewalInFlight = false;
  const renewal = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = true;
    void client
      .mutation(anyApi.usageCache.renew, { secret: cx.secret, key, owner })
      .catch(() => false)
      .finally(() => {
        renewalInFlight = false;
      });
  }, 10_000);

  const store: CacheStore = {
    commit: async (o) => {
      const committed = (await client.mutation(anyApi.usageCache.commit, {
        secret: cx.secret,
        key,
        owner,
        ...(o.usage !== undefined ? { usage: JSON.stringify(o.usage) } : {}),
        ...(o.profile !== undefined ? { profile: o.profile === null ? null : JSON.stringify(o.profile) } : {}),
        ...(o.fetchedAt !== undefined ? { fetchedAt: o.fetchedAt } : {}),
        status: o.status,
        cooldownUntil: o.cooldownUntil,
      })) as boolean;
      if (!committed) throw new Error("Usage refresh lease was lost before its result could be committed.");
    },
    release: async () => {
      await client.mutation(anyApi.usageCache.release, { secret: cx.secret, key, owner });
    },
  };

  const prior: Prior = {
    usage: parseJson<UsageData>(row?.usage),
    profile: null,
    fetchedAt: row?.fetchedAt || null,
    status: row?.status ?? null,
  };

  try {
    return await refreshAndFetch(userId, account, now, store, prior, activeRefresh);
  } catch (err) {
    await store.release().catch(() => {});
    return failedRefreshResult(prior, err);
  } finally {
    clearInterval(renewal);
  }
}

// --- Redis/KV backend (cross-instance owner-fenced coordination) ---------------

async function getAccountUsageRedis(
  config: RedisRestConfig,
  userId: string,
  account: StoredAccount,
  activeRefresh = false,
): Promise<AccountUsageResult> {
  const cache = createRedisUsageCacheFromConfig(config);
  const key = usageCacheKey(userId, account.id);
  const now = Date.now();
  const owner = globalThis.crypto.randomUUID();
  let row: RedisUsageCacheRow | null = null;
  let claim: { acquired: boolean; cached: RedisUsageCacheRow | null };

  // Redis being configured means it is the shared coordination authority. Never silently fall back
  // to a process-local lock when it is unavailable: two serverless instances could then spend the
  // same refresh token. Last-good cached data is safe to serve if the claim call itself fails.
  try {
    row = await cache.get(key);
    const action = coordinatedCacheAction(rowToEntry(row), now, activeRefresh, parseJson<UsageData>(row?.usage));
    if (action === "fresh") return readyOrStaleResult(row, false);
    if (action === "cooldown") return readyOrStaleResult(row, true);
    claim = await cache.claim(key, owner, REFRESH_LOCK_MS);
  } catch (error) {
    const message = `Shared usage coordination is unavailable: ${errMsg(error)}`;
    if (row) return { ...readyOrStaleResult(row, true), error: message };
    return {
      usage: null,
      profile: null,
      status: "error",
      fetchedAt: null,
      cooldownUntil: 0,
      stale: true,
      error: message,
    };
  }

  if (!claim.acquired) {
    // Another app instance owns the lease. The cached row was read in the same Lua script as the
    // failed claim, so it is a more current snapshot than the earlier GET.
    return readyOrStaleResult(claim.cached, true);
  }

  // Another owner may have published fresh data between our first GET and this successful claim.
  // Re-check the atomic claim snapshot and release without another upstream request when possible.
  const claimedAction = coordinatedCacheAction(rowToEntry(claim.cached), Date.now(), activeRefresh, parseJson<UsageData>(claim.cached?.usage));
  if (claimedAction === "fresh" || claimedAction === "cooldown") {
    await cache.release(key, owner).catch(() => false);
    return readyOrStaleResult(claim.cached, claimedAction === "cooldown");
  }

  let renewalInFlight = false;
  const renewal = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = true;
    void cache
      .renew(key, owner, REFRESH_LOCK_MS)
      .catch(() => false)
      .finally(() => {
        renewalInFlight = false;
      });
  }, Math.max(1_000, Math.floor(REFRESH_LOCK_MS / 3)));

  let current = claim.cached;
  const store: CacheStore = {
    commit: async (outcome) => {
      const next: RedisUsageCacheRow = {
        usage: outcome.usage !== undefined ? JSON.stringify(outcome.usage) : (current?.usage ?? null),
        profile:
          outcome.profile !== undefined
            ? outcome.profile === null
              ? null
              : JSON.stringify(outcome.profile)
            : (current?.profile ?? null),
        fetchedAt: outcome.fetchedAt !== undefined ? outcome.fetchedAt : (current?.fetchedAt ?? 0),
        status: outcome.status,
        cooldownUntil: outcome.cooldownUntil,
        refreshingUntil: 0,
      };
      const committed = await cache.commit(key, owner, next);
      if (!committed) throw new Error("Usage refresh lease was lost before its result could be committed.");
      current = next;
    },
    release: async () => {
      await cache.release(key, owner);
    },
  };
  const prior: Prior = {
    usage: parseJson<UsageData>(claim.cached?.usage),
    profile: null,
    fetchedAt: claim.cached?.fetchedAt || null,
    status: claim.cached?.status ?? null,
  };

  try {
    return await refreshAndFetch(userId, account, now, store, prior, activeRefresh);
  } catch (error) {
    await store.release().catch(() => {});
    return failedRefreshResult(prior, error);
  } finally {
    clearInterval(renewal);
  }
}

// --- Local file backend -------------------------------------------------------
// The in-process promise coalesces ordinary calls; a portable filesystem lock also serializes
// refreshes across multiple local Node processes sharing the same vault directory.

interface LocalEntry {
  usage: UsageData | null;
  profile: ProfileData | null;
  fetchedAt: number;
  status: string;
  cooldownUntil: number;
}

const localCache = new Map<string, LocalEntry>();
const localInflight = new Map<string, Promise<AccountUsageResult>>();

function localToEntry(e: LocalEntry | null): CacheEntry | null {
  if (!e) return null;
  return { hasUsage: e.usage != null, fetchedAt: e.fetchedAt, status: e.status, cooldownUntil: e.cooldownUntil, refreshingUntil: 0 };
}

function localResult(e: LocalEntry | null, stale: boolean): AccountUsageResult {
  if (!e) return { usage: null, profile: null, status: "loading", fetchedAt: null, cooldownUntil: 0, stale };
  const refreshThrottled = e.status.startsWith("refresh_throttled_");
  const status = (
    e.status === "reauth"
      ? "reauth"
      : stale
        ? e.usage
          ? "stale"
          : e.status === "error" || refreshThrottled
            ? "error"
            : "loading"
        : "ready"
  ) as AccountUsageStatus;
  return {
    usage: e.usage,
    profile: null,
    status,
    fetchedAt: e.fetchedAt || null,
    cooldownUntil: e.cooldownUntil,
    stale,
    ...(refreshThrottled
      ? { error: "Automatic renewal is temporarily throttled. The app will retry after its cooldown." }
      : {}),
  };
}

async function getAccountUsageLocal(userId: string, account: StoredAccount, activeRefresh = false): Promise<AccountUsageResult> {
  const key = usageCacheKey(userId, account.id);
  const now = Date.now();
  const entry = localCache.get(key) ?? null;

  const action = coordinatedCacheAction(localToEntry(entry), now, activeRefresh, entry?.usage);
  if (action === "fresh") return localResult(entry, false);
  if (action === "cooldown") return localResult(entry, true);

  // In-process single-flight: concurrent callers share the one upstream fetch.
  const existing = localInflight.get(key);
  if (existing) return existing;

  const store: CacheStore = {
    commit: async (o) => {
      const prev = localCache.get(key);
      localCache.set(key, {
        usage: o.usage !== undefined ? o.usage : (prev?.usage ?? null),
        profile: o.profile !== undefined ? o.profile : (prev?.profile ?? null),
        fetchedAt: o.fetchedAt !== undefined ? o.fetchedAt : (prev?.fetchedAt ?? 0),
        status: o.status,
        cooldownUntil: o.cooldownUntil,
      });
    },
    release: async () => {},
  };
  const prior: Prior = {
    usage: entry?.usage ?? null,
    profile: null,
    fetchedAt: entry?.fetchedAt || null,
    status: entry?.status ?? null,
  };

  const p = (async () => {
    try {
      return await withLocalUsageRefreshLock(userId, account.id, () =>
        refreshAndFetch(userId, account, now, store, prior, activeRefresh),
      );
    } catch (err) {
      return failedRefreshResult(prior, err);
    }
  })();
  localInflight.set(key, p);
  try {
    return await p;
  } finally {
    localInflight.delete(key);
  }
}

// Drop an account's cached reauth/cooldown state after it's (re)connected with fresh tokens, so the
// next poll refetches immediately instead of serving "re-add this account" for the rest of a cooldown.
// Best-effort: the read-path heal (decideCacheActionWithTokens) covers a missed clear.
export async function clearAccountUsageState(userId: string, accountId: string): Promise<void> {
  const key = usageCacheKey(userId, accountId);
  localCache.delete(key);
  const cx = convexConfig();
  if (cx) {
    try {
      const client = new ConvexHttpClient(cx.url);
      await client.mutation(anyApi.usageCache.reset, { secret: cx.secret, key });
    } catch {
      // Best effort — see above.
    }
    return;
  }
  const redis = redisUsageConfig();
  if (redis) {
    try {
      await createRedisUsageCacheFromConfig(redis).clear(key);
    } catch {
      // Best effort — see above.
    }
  }
}

// The one entry point. `account` carries the id (cache key) and the caller's view of the tokens; the
// vault is the authoritative token source when a refresh is actually needed.
export async function getAccountUsage(userId: string, account: StoredAccount, opts?: { activeRefresh?: boolean }): Promise<AccountUsageResult> {
  let persisted: StoredAccount | undefined;
  try {
    persisted = (await loadAccounts(userId)).find((candidate) => candidate.id === account.id);
  } catch (error) {
    return {
      usage: null,
      profile: null,
      status: "error",
      fetchedAt: null,
      cooldownUntil: 0,
      stale: true,
      error: `Couldn't read the authoritative credential: ${errMsg(error)}`,
    };
  }
  if (!persisted) {
    return {
      usage: null,
      profile: null,
      status: "error",
      fetchedAt: null,
      cooldownUntil: 0,
      stale: true,
      error: "This account is no longer connected.",
    };
  }
  // Ignore the browser's token fields entirely. `accountId` is the lookup key; the server vault is
  // the sole credential authority and remains correct even for a stale tab or a future id-only API.
  const effective = persisted;
  const activeRefresh = Boolean(effective.sub2api && opts?.activeRefresh);
  const cx = convexConfig();
  const redis = cx ? null : redisUsageConfig();
  const result = cx ? await getAccountUsageConvex(cx, userId, effective, activeRefresh)
    : redis ? await getAccountUsageRedis(redis, userId, effective, activeRefresh)
      : await getAccountUsageLocal(userId, effective, activeRefresh);
  if (effective.sub2api && result.usage) {
    const sampled = Date.parse(result.usage.snapshot?.sampledAt ?? "");
    if (!Number.isFinite(sampled) || sampled > Date.now() + 60_000 || Date.now() - sampled > CACHE_TTL_MS) {
      return { ...result, stale: true, status: result.status === "ready" ? "stale" : result.status };
    }
  }
  return result;
}

// One-shot verification for the add-account flow. This credential is not durable yet and there is
// no account id to coordinate or persist against, so it must NEVER spend a rotating refresh token.
// The caller should use the private app-owned OAuth flow when a pasted legacy credential fails.
export async function fetchUsageOnce(
  tokens: AccountTokens,
): Promise<{ usage: UsageData; profile: ProfileData | null }> {
  if (!tokens.accessToken) {
    throw new AnthropicError(
      "That credential has no access token. Use the private app login, or copy the legacy credential again.",
      401,
    );
  }
  try {
    const [usage, profile] = await Promise.all([
      fetchUsage(tokens.accessToken),
      fetchProfileForCredential(tokens),
    ]);
    return { usage, profile };
  } catch (err) {
    if (err instanceof AnthropicError && err.status === 401) {
      throw new AnthropicError(
        "That credential is expired or was rejected. For safety it was not renewed before being saved. Use the private app login, or copy the legacy credential again.",
        401,
      );
    }
    throw err;
  }
}
