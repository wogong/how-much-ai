import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(path.join(projectRoot, `${specifier.slice(2)}.ts`)).href, context);
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith(pathToFileURL(projectRoot).href) &&
      !context.parentURL.includes("/node_modules/") &&
      path.extname(new URL(specifier, context.parentURL).pathname) === ""
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hma-sub2api-test-"));
for (const key of ["APP_PASSWORD", "AUTH_SECRET", "CONVEX_URL", "NEXT_PUBLIC_CONVEX_URL", "VAULT_ACCESS_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[key];
process.env.VAULT_DATA_DIR = dataDir;
process.env.VAULT_ENCRYPTION_SECRET = "sub2api-unit-test-vault-secret";
const { POST } = await import("../app/api/connect/sub2api/route.ts");
const { loadAccounts, saveAccounts, parseStoredAccounts } = await import("./vault.ts");
const { getAccountUsage, clearAccountUsageState } = await import("./usage-service.ts");
const { toBrowserAccount, toBrowserUsageResponse } = await import("./browser-boundary.ts");
const { normalizeSub2ApiSnapshot, sub2ApiAccountId, syncSub2ApiAccounts } = await import("./sub2api.ts");
const { normalizeSub2ApiUrl } = await import("./sub2api-config.ts");
const { extractBars } = await import("./format.ts");
const adminKey = "test-admin-key-not-a-real-credential";
const baseUrl = "https://sub2api.example.test";
let upstream: Record<string, unknown>;
let calls: string[];
let upstreamStatus = 200;
const envelope = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });
function request(body: Record<string, unknown>, headers = {}) {
  return new Request("http://localhost/api/connect/sub2api", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ baseUrl, adminKey, ...body }),
  });
}
async function connect(id = 42) {
  const response = await POST(request({ action: "connect", accountId: id }));
  assert.equal(response.status, 200);
  return response;
}
beforeEach(async () => {
  upstream = {
    id: 42, name: "Subscription account", platform: "openai", type: "oauth",
    credentials: { email: "test@example.test", plan_type: "plus", access_token: "upstream-access-must-not-return", refresh_token: "upstream-refresh-must-not-return" },
    extra: { codex_5h_used_percent: 25, codex_5h_reset_at: new Date(Date.now() + 3600000).toISOString(), codex_usage_updated_at: new Date().toISOString(), secret: "must-not-return-extra" },
  };
  calls = [];
  upstreamStatus = 200;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-api-key"), adminKey);
    if (upstreamStatus !== 200) return new Response("remote secret must-not-return", { status: upstreamStatus });
    assert.ok(url.startsWith(baseUrl + "/api/v1/admin/accounts"));
    assert.ok(!url.includes("/usage") && !url.includes("/refresh"));
    return url.includes("?") ? envelope({ items: [upstream, { ...upstream, id: 99, type: "apikey" }], total: 51 }) : envelope(upstream);
  }) as typeof fetch;
  const accounts = await loadAccounts("default");
  for (const account of accounts) await clearAccountUsageState("default", account.id);
  await saveAccounts("default", []);
});
after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
  moduleHooks.deregister();
});

test("list paginates, filters supported types, and returns only display metadata", async () => {
  const response = await POST(request({ action: "list", provider: "openai", page: 2 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { accounts: [{ accountId: 42, name: "Subscription account", email: "test@example.test", plan: "ChatGPT Plus", provider: "openai" }], hasMore: false });
  assert.match(calls[0], /page=2&page_size=50&platform=openai$/);
  assert.equal((await loadAccounts("default")).length, 0);
});

test("connect encrypts admin key, never persists upstream credentials, and preserves duplicate nicknames", async () => {
  const response = await connect();
  const text = await response.text();
  assert.ok(!text.includes(adminKey) && !text.includes("must-not-return"));
  let [account] = await loadAccounts("default");
  assert.deepEqual(account.sub2api, { baseUrl, accountId: 42 });
  assert.equal(account.tokens.accessToken, adminKey);
  assert.equal(account.tokens.refreshToken, null);
  assert.ok(!JSON.stringify(account).includes("must-not-return"));
  const encrypted = await fs.readFile(path.join(dataDir, "vault.enc"), "utf8");
  assert.ok(!encrypted.includes(adminKey));
  assert.deepEqual(toBrowserAccount(account).source, "sub2api");
  assert.ok(!JSON.stringify(toBrowserAccount(account)).includes(adminKey));
  await saveAccounts("default", [{ ...account, label: "My label", addedAt: 123 }]);
  await connect();
  [account] = await loadAccounts("default");
  assert.equal(account.label, "My label");
  assert.equal(account.addedAt, 123);
});

test("external accounts bypass expiry, token refresh and provider profile; concurrent usage is coalesced", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  calls = [];
  const results = await Promise.all([getAccountUsage("default", account), getAccountUsage("default", account)]);
  assert.equal(calls.length, 1);
  assert.equal(results[0].usage?.five_hour?.utilization, 25);
  assert.equal(results[0].profile, null);
  assert.equal(results[0].stale, false);
  assert.ok(!JSON.stringify(toBrowserUsageResponse(results[0])).includes("must-not-return"));
  assert.equal((await getAccountUsage("default", account)).usage?.five_hour?.utilization, 25);
  assert.equal(calls.length, 1);
});

test("Claude externally managed snapshot does not call Anthropic profile or OAuth", async () => {
  upstream.platform = "anthropic";
  upstream.extra = { session_window_utilization: 0.42, passive_usage_7d_utilization: 0.15, passive_usage_7d_reset: Math.floor(Date.now()/1000) + 60000, passive_usage_sampled_at: new Date().toISOString() };
  upstream.session_window_end = new Date(Date.now() + 600000).toISOString();
  await connect();
  const [account] = await loadAccounts("default");
  calls = [];
  const result = await getAccountUsage("default", account);
  assert.equal(result.usage?.five_hour?.utilization, 42);
  assert.equal(result.usage?.seven_day?.utilization, 15);
  assert.equal(result.profile, null);
  assert.equal(calls.length, 1);
});

test("rejected admin key requires reconnect without attempting upstream rotation", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  upstreamStatus = 403;
  calls = [];
  const result = await getAccountUsage("default", account);
  assert.equal(result.status, "reauth");
  assert.equal(calls.length, 1);
  assert.match(result.error ?? "", /admin key/);
  await getAccountUsage("default", account);
  assert.equal(calls.length, 1);
});

test("old or undated snapshots stay stale on cache hits", async () => {
  (upstream.extra as Record<string, unknown>).codex_usage_updated_at = new Date(Date.now() - 3600000).toISOString();
  await connect();
  const [account] = await loadAccounts("default");
  assert.equal((await getAccountUsage("default", account)).stale, true);
  assert.equal((await getAccountUsage("default", account)).stale, true);
});

test("missing, invalid, and expired windows never become 100 percent remaining", () => {
  const now = Date.parse("2026-09-16T00:00:00Z");
  assert.equal(normalizeSub2ApiSnapshot({}, "openai", now).five_hour, undefined);
  assert.equal(normalizeSub2ApiSnapshot({ extra: { codex_5h_used_percent: "bad" } }, "openai", now).five_hour, undefined);
  assert.equal(normalizeSub2ApiSnapshot({ extra: { codex_5h_used_percent: null } }, "openai", now).five_hour, undefined);
  assert.equal(normalizeSub2ApiSnapshot({ extra: { codex_5h_used_percent: 70, codex_5h_reset_at: "2026-09-15T23:00:00Z" } }, "openai", now).five_hour, undefined);
  const measuredZero = normalizeSub2ApiSnapshot({ extra: { codex_5h_used_percent: 0 } }, "openai", now);
  assert.equal(measuredZero.five_hour?.utilization, 0);
  const relative = normalizeSub2ApiSnapshot({ extra: { codex_5h_used_percent: 40, codex_usage_updated_at: "2026-09-16T00:00:00Z", codex_5h_reset_after_seconds: 3600 } }, "openai", now);
  assert.equal(relative.five_hour?.resets_at, "2026-09-16T01:00:00.000Z");
  const undated = normalizeSub2ApiSnapshot({ extra: { codex_5h_used_percent: 40, codex_5h_reset_after_seconds: 3600 } }, "openai", now);
  assert.equal(undated.five_hour?.resets_at, null);
  // The same cached reading must disappear after its window ends, even before another fetch.
  assert.equal(extractBars(relative, now).length, 1);
  assert.equal(extractBars(relative, now + 3600000).length, 0);
  assert.equal(extractBars({ five_hour: relative.five_hour }, now + 3600000).length, 1, "direct-provider behavior is unchanged");
});

test("connection requires same origin, authentication, valid input, and bounded bodies", async () => {
  const list = { action: "list", provider: "openai" };
  assert.equal((await POST(request(list, { Origin: "https://attacker.test" }))).status, 403);
  process.env.APP_PASSWORD = "test-password";
  try { assert.equal((await POST(request(list))).status, 401); } finally { delete process.env.APP_PASSWORD; }
  for (const patch of [{ baseUrl: "file:///etc/passwd" }, { baseUrl: "https://user:pass@example.test" }, { page: -1 }, { adminKey: "" }, { provider: "other" }]) {
    assert.equal((await POST(request({ ...list, ...patch }))).status, 400);
  }
  assert.equal((await POST(request({ ...list, padding: "x".repeat(33000) }))).status, 413);
  assert.equal(calls.length, 0);
});

test("reconnect cannot overwrite a different account or instance", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  upstream.id = 43;
  const response = await POST(request({ action: "connect", accountId: 43, expectedAccountId: account.id }));
  assert.equal(response.status, 409);
  assert.equal((await loadAccounts("default")).length, 1);
  assert.notEqual(sub2ApiAccountId(baseUrl, 42), sub2ApiAccountId("https://other.test", 42));
});

test("vault validates and retains external source without accepting rotating credentials", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  assert.deepEqual(parseStoredAccounts([account])[0].sub2api, account.sub2api);
  assert.throws(() => parseStoredAccounts([{ ...account, sub2api: { baseUrl, accountId: -1 } }]));
  assert.throws(() => parseStoredAccounts([{ ...account, sub2api: { baseUrl: "file:///etc/passwd", accountId: 42 } }]));
  assert.throws(() => parseStoredAccounts([{ ...account, credentialKind: "rotating", tokens: { ...account.tokens, refreshToken: "test-refresh" } }]));
  assert.equal(normalizeSub2ApiUrl(baseUrl + "/api/v1/"), baseUrl);
});

test("errors never reflect upstream bodies or exception messages", async () => {
  upstreamStatus = 500;
  const response = await POST(request({ action: "list", provider: "openai" }));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("must-not-return"));
  globalThis.fetch = async () => { throw new Error(adminKey); };
  const failure = await POST(request({ action: "list", provider: "openai" }));
  assert.ok(!(await failure.text()).includes(adminKey));
});

test("one setup lists and connects both providers across all pages atomically", async () => {
  await connect();
  const [original] = await loadAccounts("default");
  const unrelated = { ...original, id: "unrelated-existing-account", sub2api: undefined };
  await saveAccounts("default", [{ ...original, label: "Keep my nickname", addedAt: 123 }, unrelated]);
  const claude = { ...upstream, id: 43, platform: "anthropic", name: "Claude account" };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(init?.method, "GET");
    assert.equal(url.pathname, "/api/v1/admin/accounts");
    assert.equal(url.searchParams.has("platform"), false);
    const page = Number(url.searchParams.get("page"));
    return envelope({ items: page === 1 ? [upstream, { ...upstream, id: 99, type: "apikey" }] : [claude, upstream], total: 51 });
  }) as typeof fetch;
  const list = await POST(request({ action: "list" }));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).accounts.length, 1);
  calls = [];
  const response = await POST(request({ action: "connect_all" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 2);
  assert.ok(!JSON.stringify(body).includes(adminKey));
  assert.equal(calls.length, 2);
  const accounts = await loadAccounts("default");
  assert.equal(accounts.length, 3);
  assert.equal(accounts.find(a => a.id === original.id)?.label, "Keep my nickname");
  assert.equal(accounts.find(a => a.id === original.id)?.addedAt, 123);
  assert.equal(accounts.find(a => a.sub2api?.accountId === 43)?.provider, undefined, "Claude uses the default provider in the vault");
  assert.deepEqual(accounts.find(a => a.id === unrelated.id), parseStoredAccounts([unrelated])[0]);
  assert.ok(!JSON.stringify(accounts).includes("must-not-return"));
  await POST(request({ action: "connect_all" }));
  assert.equal((await loadAccounts("default")).length, 3);
});

test("sync appends accounts added upstream, throttles per instance, and never drops existing ones", async () => {
  await connect();
  const [original] = await loadAccounts("default");
  await saveAccounts("default", [{ ...original, label: "Keep my nickname" }]);
  const claude = { ...upstream, id: 43, platform: "anthropic", name: "Claude account" };
  let items = [upstream, claude];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(url.pathname, "/api/v1/admin/accounts");
    return envelope({ items, total: items.length });
  }) as typeof fetch;
  calls = [];
  assert.deepEqual(await syncSub2ApiAccounts("default", { force: true }), { added: 1 });
  assert.equal(calls.length, 1);
  let accounts = await loadAccounts("default");
  assert.equal(accounts.length, 2);
  assert.equal(accounts.find(a => a.id === original.id)?.label, "Keep my nickname");
  assert.equal(accounts.find(a => a.sub2api?.accountId === 43)?.tokens.accessToken, adminKey);
  // Within the interval the list is not re-read; a forced sync sees the newer upstream account.
  items = [upstream, claude, { ...claude, id: 44 }];
  assert.deepEqual(await syncSub2ApiAccounts("default"), { added: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(await syncSub2ApiAccounts("default", { force: true }), { added: 1 });
  assert.equal((await loadAccounts("default")).length, 3);
  // A vanished upstream account is retained; a failed list leaves the vault untouched.
  items = [upstream];
  assert.deepEqual(await syncSub2ApiAccounts("default", { force: true }), { added: 0 });
  assert.equal((await loadAccounts("default")).length, 3);
  upstreamStatus = 401;
  globalThis.fetch = (async () => new Response("must-not-return", { status: 401 })) as typeof fetch;
  await assert.rejects(syncSub2ApiAccounts("default", { force: true }), /rejected the admin key/);
  accounts = await loadAccounts("default");
  assert.equal(accounts.length, 3);
  assert.equal(accounts.find(a => a.id === original.id)?.label, "Keep my nickname");
});

test("mixed-provider list presents both suppliers without a provider filter", async () => {
  globalThis.fetch = async () => envelope({ items: [upstream, { ...upstream, id: 43, platform: "anthropic" }, { ...upstream, id: 44, platform: "gemini" }], total: 3 });
  const response = await POST(request({ action: "list" }));
  const body = await response.json();
  assert.deepEqual(body.accounts.map((a: { provider: string }) => a.provider), ["openai", "anthropic"]);
  assert.ok(!JSON.stringify(body).includes("must-not-return"));
});

test("a failed later page leaves the vault unchanged", async () => {
  await connect();
  const before = await loadAccounts("default");
  globalThis.fetch = async input => new URL(String(input)).searchParams.get("page") === "1"
    ? envelope({ items: [{ ...upstream, id: 43, platform: "anthropic" }], total: 51 })
    : new Response("remote secret must-not-return", { status: 500 });
  const response = await POST(request({ action: "connect_all" }));
  assert.equal(response.status, 502);
  assert.deepEqual(await loadAccounts("default"), before);
});

test("empty imports and vault capacity errors do not partially save or erase accounts", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  globalThis.fetch = async () => envelope({ items: [], total: 0 });
  assert.equal((await POST(request({ action: "connect_all" }))).status, 422);
  assert.equal((await loadAccounts("default")).length, 1);
  const full = Array.from({ length: 500 }, (_, index) => ({ ...account, id: `existing-${index}`, sub2api: undefined }));
  await saveAccounts("default", full);
  globalThis.fetch = async () => envelope({ items: [upstream], total: 1 });
  assert.equal((await POST(request({ action: "connect_all" }))).status, 422);
  assert.deepEqual(await loadAccounts("default"), parseStoredAccounts(full));
  assert.equal((await POST(request({ action: "connect_all", expectedAccountId: account.id }))).status, 400);
});

test("manual refresh bypasses passive cache, invokes active usage, then rereads the Codex sample", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  (upstream.extra as Record<string, unknown>).codex_usage_updated_at = new Date(Date.now() - 3600000).toISOString();
  const passive = await getAccountUsage("default", account);
  assert.equal(passive.stale, true);
  const originalRead = globalThis.fetch;
  let activeCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/usage?")) {
      activeCalls++;
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("x-api-key"), adminKey);
      assert.match(String(input), /\/42\/usage\?source=active&force=true$/);
      upstream.extra = { codex_5h_used_percent: 38, codex_5h_reset_at: new Date(Date.now() + 3600000).toISOString(), codex_usage_updated_at: new Date().toISOString() };
      return envelope({ updated_at: new Date().toISOString(), five_hour: { utilization: 0 }, secret: adminKey });
    }
    return originalRead(input, init);
  }) as typeof fetch;
  const results = await Promise.all(Array.from({ length: 4 }, () => getAccountUsage("default", account, { activeRefresh: true })));
  assert.equal(activeCalls, 1);
  for (const result of results) {
    assert.equal(result.usage?.five_hour?.utilization, 38);
    assert.equal(result.stale, false);
    assert.ok(result.usage?.snapshot?.refreshCompletedAt);
    assert.ok(!JSON.stringify(toBrowserUsageResponse(result)).includes(adminKey));
  }
  await getAccountUsage("default", account, { activeRefresh: true });
  await getAccountUsage("default", account);
  assert.equal(activeCalls, 1, "rapid clicks reuse the recent active refresh");
});

test("Codex probing can return success without a newer sample; do not mark old or missing data fresh", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  upstream.extra = { codex_5h_used_percent: 70, codex_usage_updated_at: new Date(Date.now() - 3600000).toISOString() };
  const originalRead = globalThis.fetch;
  globalThis.fetch = (async (input, init) => String(input).includes("/usage?")
    ? envelope({ updated_at: new Date().toISOString(), five_hour: { utilization: 0, window_stats: {} } })
    : originalRead(input, init)) as typeof fetch;
  const result = await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(result.stale, true);
  assert.equal(result.usage?.five_hour?.utilization, 70);
  assert.ok(result.usage?.snapshot?.refreshCompletedAt);
  await clearAccountUsageState("default", account.id);
  upstream.extra = {};
  const empty = await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(empty.usage?.five_hour, undefined);
  assert.equal(empty.stale, true);
});

test("Claude manual refresh consumes allowlisted active windows and reported timestamp", async () => {
  upstream.platform = "anthropic";
  upstream.extra = {};
  await connect();
  const [account] = await loadAccounts("default");
  const sampled = new Date().toISOString();
  const reset = new Date(Date.now() + 3600000).toISOString();
  const originalRead = globalThis.fetch;
  globalThis.fetch = (async (input, init) => String(input).includes("/usage?")
    ? envelope({ updated_at: sampled, five_hour: { utilization: 45, resets_at: reset, access_token: "must-not-return" }, seven_day_sonnet: { utilization: 12, resets_at: reset }, secret: adminKey })
    : originalRead(input, init)) as typeof fetch;
  const result = await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(result.usage?.five_hour?.utilization, 45);
  assert.equal(result.usage?.seven_day_sonnet?.utilization, 12);
  assert.equal(result.usage?.snapshot?.sampledAt, sampled);
  assert.equal(result.stale, false);
  assert.ok(!JSON.stringify(result.usage).includes("must-not-return"));
  assert.ok(!JSON.stringify(result.usage).includes(adminKey));
});

test("empty Claude active responses cannot mark old quota fresh", async () => {
  upstream.platform = "anthropic";
  const sampled = new Date(Date.now() - 3600000).toISOString();
  upstream.extra = { session_window_utilization: 0.7, passive_usage_sampled_at: sampled };
  await connect();
  const [account] = await loadAccounts("default");
  const originalRead = globalThis.fetch;
  globalThis.fetch = (async (input, init) => String(input).includes("/usage?")
    ? envelope({ updated_at: new Date().toISOString() })
    : originalRead(input, init)) as typeof fetch;
  const result = await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(result.stale, true);
  assert.equal(result.usage?.snapshot?.sampledAt, sampled);
  assert.equal(result.usage?.five_hour?.utilization, 70);
});

test("active failures preserve the last sample and respect 429 backoff even with a fresh passive cache", async () => {
  await connect();
  const [account] = await loadAccounts("default");
  const passive = await getAccountUsage("default", account);
  const originalRead = globalThis.fetch;
  let activeCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/usage?")) {
      activeCalls++;
      return new Response("must-not-return", { status: 429 });
    }
    return originalRead(input, init);
  }) as typeof fetch;
  const result = await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(result.stale, true);
  assert.deepEqual(result.usage, passive.usage);
  assert.ok(result.cooldownUntil > Date.now());
  await getAccountUsage("default", account, { activeRefresh: true });
  assert.equal(activeCalls, 1);
});

test("active usage route validates intent and guards it with origin and password authentication", async () => {
  const { POST: usagePost } = await import("../app/api/usage/route.ts");
  await connect();
  const [account] = await loadAccounts("default");
  const makeRequest = (activeRefresh: unknown, headers = {}) => new Request("http://localhost/api/usage", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ accountId: account.id, activeRefresh }),
  });
  calls = [];
  assert.equal((await usagePost(makeRequest("true"))).status, 400);
  assert.equal((await usagePost(makeRequest(true, { Origin: "https://attacker.test" }))).status, 403);
  process.env.APP_PASSWORD = "test-password";
  try { assert.equal((await usagePost(makeRequest(true))).status, 401); } finally { delete process.env.APP_PASSWORD; }
  assert.equal(calls.length, 0);
  const originalRead = globalThis.fetch;
  let activeCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/usage?")) { activeCalls++; return envelope({}); }
    return originalRead(input, init);
  }) as typeof fetch;
  assert.equal((await usagePost(makeRequest(false))).status, 200);
  assert.equal(activeCalls, 0);
  assert.equal((await usagePost(makeRequest(true))).status, 200);
  assert.equal(activeCalls, 1);
});
