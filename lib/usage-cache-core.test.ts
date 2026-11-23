import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideCacheActionWithTokens,
  isUsageRetryBlocked,
  decideCacheAction,
  needsRefresh,
  claimDecision,
  reauthPatch,
  CACHE_TTL_MS,
  REFRESH_LOCK_MS,
  COOLDOWN_MS,
  TOKEN_SKEW_MS,
  type CacheEntry,
} from "./usage-cache-core.ts";

const NOW = 1_000_000_000_000;

function entry(over: Partial<CacheEntry> = {}): CacheEntry {
  return { hasUsage: true, fetchedAt: NOW, status: "ready", cooldownUntil: 0, refreshingUntil: 0, ...over };
}

// --- decideCacheAction --------------------------------------------------------

test("decideCacheAction: no entry → fetch", () => {
  assert.equal(decideCacheAction(null, NOW), "fetch");
});

test("decideCacheAction: entry within TTL → fresh (served from cache, no upstream)", () => {
  assert.equal(decideCacheAction(entry({ fetchedAt: NOW - (CACHE_TTL_MS - 1) }), NOW), "fresh");
});

test("decideCacheAction: entry exactly at TTL boundary → fetch (stale)", () => {
  assert.equal(decideCacheAction(entry({ fetchedAt: NOW - CACHE_TTL_MS }), NOW), "fetch");
});

test("decideCacheAction: entry older than TTL → fetch", () => {
  assert.equal(decideCacheAction(entry({ fetchedAt: NOW - CACHE_TTL_MS * 2 }), NOW), "fetch");
});

test("decideCacheAction: stale entry inside cooldown → cooldown (serve stale, do NOT hit upstream)", () => {
  const e = entry({ fetchedAt: NOW - CACHE_TTL_MS * 2, cooldownUntil: NOW + 60_000 });
  assert.equal(decideCacheAction(e, NOW), "cooldown");
});

test("decideCacheAction: cooldown expired → fetch again", () => {
  const e = entry({ fetchedAt: NOW - CACHE_TTL_MS * 2, cooldownUntil: NOW - 1 });
  assert.equal(decideCacheAction(e, NOW), "fetch");
});

test("decideCacheAction: entry with no usage but recent fetchedAt → fetch (nothing to serve)", () => {
  assert.equal(decideCacheAction(entry({ hasUsage: false }), NOW), "fetch");
});

test("decideCacheAction: fresh data takes precedence over a lingering cooldown", () => {
  // Both true is not expected in practice, but fresh must win so a just-refreshed account
  // is never wrongly reported as stale.
  const e = entry({ fetchedAt: NOW, cooldownUntil: NOW + 60_000 });
  assert.equal(decideCacheAction(e, NOW), "fresh");
});

// --- needsRefresh -------------------------------------------------------------

test("needsRefresh: missing access token → true", () => {
  assert.equal(needsRefresh({ accessToken: null, expiresAt: NOW + 10 * 3600_000 }, NOW), true);
  assert.equal(needsRefresh({ accessToken: "", expiresAt: NOW + 10 * 3600_000 }, NOW), true);
});

test("needsRefresh: a dedicated access-only monitor token is never sent to the refresh endpoint", () => {
  assert.equal(needsRefresh({ accessToken: "sk", refreshToken: null, expiresAt: NOW - 1 }, NOW), false);
});

test("needsRefresh: token well in the future → false", () => {
  assert.equal(needsRefresh({ accessToken: "sk", expiresAt: NOW + 2 * TOKEN_SKEW_MS }, NOW), false);
});

test("needsRefresh: token expiring inside the skew window → true", () => {
  assert.equal(needsRefresh({ accessToken: "sk", expiresAt: NOW + TOKEN_SKEW_MS - 1 }, NOW), true);
});

test("needsRefresh: token exactly at the skew boundary → false (not yet)", () => {
  assert.equal(needsRefresh({ accessToken: "sk", expiresAt: NOW + TOKEN_SKEW_MS }, NOW), false);
});

test("needsRefresh: already-expired token → true", () => {
  assert.equal(needsRefresh({ accessToken: "sk", expiresAt: NOW - 1 }, NOW), true);
});

// --- claimDecision (single-flight lock CAS) -----------------------------------

test("claimDecision: no entry → acquire, set lock to now+lockMs", () => {
  assert.deepEqual(claimDecision(null, NOW), { acquired: true, refreshingUntil: NOW + REFRESH_LOCK_MS });
});

test("claimDecision: entry with expired lock → acquire", () => {
  assert.deepEqual(claimDecision({ refreshingUntil: NOW - 1 }, NOW), {
    acquired: true,
    refreshingUntil: NOW + REFRESH_LOCK_MS,
  });
});

test("claimDecision: entry with an active lock held by another → do NOT acquire", () => {
  const held = NOW + 5_000;
  assert.deepEqual(claimDecision({ refreshingUntil: held }, NOW), { acquired: false, refreshingUntil: held });
});

test("claimDecision: lock exactly at now (boundary) → acquire (not strictly held)", () => {
  assert.deepEqual(claimDecision({ refreshingUntil: NOW }, NOW), {
    acquired: true,
    refreshingUntil: NOW + REFRESH_LOCK_MS,
  });
});

// --- reauthPatch --------------------------------------------------------------

test("reauthPatch: marks reauth and sets a 15-minute cooldown so we never retry-storm", () => {
  assert.deepEqual(reauthPatch(NOW), { status: "reauth", cooldownUntil: NOW + COOLDOWN_MS });
  assert.equal(COOLDOWN_MS, 15 * 60_000);
});

// --- decideCacheActionWithTokens (the reconnect self-heal) ---------------------

const reauthEntry = (over: Partial<import("./usage-cache-core").CacheEntry> = {}) => ({
  hasUsage: false,
  fetchedAt: 0,
  status: "reauth",
  cooldownUntil: NOW + 60_000,
  refreshingUntil: 0,
  ...over,
});

test("withTokens: reauth cooldown + VALID tokens → fetch (account was re-added; heal now)", () => {
  assert.equal(decideCacheActionWithTokens(reauthEntry(), NOW, true), "fetch");
});

test("withTokens: reauth cooldown + invalid tokens → cooldown (token still dead; keep showing re-add)", () => {
  assert.equal(decideCacheActionWithTokens(reauthEntry(), NOW, false), "cooldown");
});

test("withTokens: NON-reauth cooldown (usage-endpoint 429) is NOT bypassed by valid tokens", () => {
  assert.equal(decideCacheActionWithTokens(reauthEntry({ status: "stale", hasUsage: true }), NOW, true), "cooldown");
});

test("withTokens: fresh cache still wins regardless of token validity", () => {
  const entry = reauthEntry({ status: "ready", hasUsage: true, fetchedAt: NOW - 1000, cooldownUntil: 0 });
  assert.equal(decideCacheActionWithTokens(entry, NOW, false), "fresh");
});

test("withTokens: no entry → fetch (same as base rule)", () => {
  assert.equal(decideCacheActionWithTokens(null, NOW, true), "fetch");
});


test("dashboard and server retry external auth failures only after cooldown", () => {
  const rejected = { status: "reauth", cooldownUntil: NOW + COOLDOWN_MS };
  assert.equal(isUsageRetryBlocked(rejected, NOW, true), true);
  assert.equal(isUsageRetryBlocked(rejected, rejected.cooldownUntil, true), false);
  assert.equal(isUsageRetryBlocked(rejected, rejected.cooldownUntil + 1, false), true);
  assert.equal(isUsageRetryBlocked({ status: "stale", cooldownUntil: NOW + 1 }, NOW, true), true);
  assert.equal(isUsageRetryBlocked(undefined, NOW, true), false);
});
