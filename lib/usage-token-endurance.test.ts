import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CACHE_TTL_MS, COOLDOWN_MS } from "./usage-cache-core.ts";
import type { StoredAccount } from "./types.ts";

// Production uses bundler-style extensionless imports. Teach Node's type-stripping test runner how
// to resolve them before importing the real usage service and vault.
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { fetchUsageOnce, getAccountUsage } = await import("./usage-service.ts");
const { loadAccounts, saveAccounts } = await import("./vault.ts");

const ENV_KEYS = [
  "APP_PASSWORD",
  "VAULT_ENCRYPTION_SECRET",
  "VAULT_DATA_DIR",
  "CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "VAULT_ACCESS_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
let dataDir = "";

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-token-endurance-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.VAULT_DATA_DIR = dataDir;
  process.env.VAULT_ENCRYPTION_SECRET = "token-endurance-test-secret";
});

after(async () => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  await fs.rm(dataDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  moduleHooks.deregister();
});

const TOKEN_URL_FRAGMENT = "/v1/oauth/token";
const USAGE_URL_FRAGMENT = "/api/oauth/usage";
const PROFILE_URL_FRAGMENT = "/api/oauth/profile";

function account(id: string, now: number, tokens?: Partial<StoredAccount["tokens"]>): StoredAccount {
  return {
    id,
    email: `${id}@example.com`,
    fullName: `Token Test ${id}`,
    plan: "Max",
    addedAt: now - 86_400_000,
    tokens: {
      accessToken: `access-${id}-0`,
      refreshToken: `refresh-${id}-0`,
      expiresAt: now - 1,
      ...tokens,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearer(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("Authorization");
}

test("expired access token rotates once for simultaneous dashboard+cron callers and is durable before usage", async () => {
  const now = 1_900_000_000_000;
  Date.now = () => now;
  const userId = "simultaneous-callers";
  const stored = account("simultaneous", now);
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  let usageCalls = 0;
  let profileCalls = 0;
  let persistedBeforeUsage = false;
  const usedRefreshTokens = new Set<string>();

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      if (usedRefreshTokens.has(body.refresh_token)) {
        return json({ error: "invalid_grant", error_description: "single-use token already spent" }, 400);
      }
      usedRefreshTokens.add(body.refresh_token);
      assert.equal(body.refresh_token, stored.tokens.refreshToken);
      return json({
        access_token: "access-simultaneous-1",
        refresh_token: "refresh-simultaneous-1",
        expires_in: 8 * 60 * 60,
      });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageCalls += 1;
      assert.equal(bearer(init), "Bearer access-simultaneous-1");
      const durable = (await loadAccounts(userId))[0].tokens;
      persistedBeforeUsage = durable.refreshToken === "refresh-simultaneous-1";
      return json({ five_hour: { utilization: 21, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) {
      profileCalls += 1;
      assert.equal(bearer(init), "Bearer access-simultaneous-1");
      return json({ account: { uuid: stored.id, email: stored.email } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // These are the two real call shapes: a background cron copy loaded from the vault and a
  // dashboard tab holding its own snapshot. The in-process coordinator must share one promise.
  const [dashboard, cron] = await Promise.all([
    getAccountUsage(userId, { ...stored, tokens: { ...stored.tokens } }),
    getAccountUsage(userId, { ...stored, tokens: { ...stored.tokens } }),
  ]);

  assert.equal(dashboard.status, "ready");
  assert.equal(cron.status, "ready");
  assert.equal(tokenCalls, 1, "the one-time refresh credential was spent exactly once");
  assert.equal(usageCalls, 1, "the dashboard and cron shared the upstream usage read");
  assert.equal(profileCalls, 1);
  assert.equal(persistedBeforeUsage, true, "the rotated pair was durable before a ready result could escape");
  assert.equal((await loadAccounts(userId))[0].tokens.refreshToken, "refresh-simultaneous-1");
});

test("an app-managed login renews with its original least-privilege monitoring scope", async () => {
  const now = 1_900_025_000_000;
  Date.now = () => now;
  const userId = "managed-scope";
  const stored: StoredAccount = { ...account("managed-scope", now), credentialKind: "managed" };
  await saveAccounts(userId, [stored]);

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.refresh_token, stored.tokens.refreshToken);
      assert.equal(body.scope, "user:profile user:inference");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("anthropic-beta"), null);
      assert.equal(headers.get("user-agent"), null);
      return json({
        access_token: "access-managed-r1",
        refresh_token: "refresh-managed-r1",
        expires_in: 8 * 60 * 60,
      });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      assert.equal(bearer(init), "Bearer access-managed-r1");
      return json({ five_hour: { utilization: 23, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await getAccountUsage(userId, stored);
  assert.equal(result.status, "ready");
  const [persisted] = await loadAccounts(userId);
  assert.equal(persisted.credentialKind, "managed");
  assert.equal(persisted.tokens.refreshToken, "refresh-managed-r1");
});

test("repeated expiry cycles renew automatically for a full day without a manual reconnect", async () => {
  let now = 1_900_050_000_000;
  Date.now = () => now;
  const userId = "day-long-endurance";
  const original = account("endurance", now, {
    accessToken: "access-r0",
    refreshToken: "refresh-r0",
    expiresAt: now - 1,
  });
  await saveAccounts(userId, [original]);

  let generation = 0;
  let tokenCalls = 0;
  const usageGenerations: number[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      assert.equal(body.refresh_token, `refresh-r${generation}`);
      generation += 1;
      return json({
        access_token: `access-r${generation}`,
        refresh_token: `refresh-r${generation}`,
        expires_in: 8 * 60 * 60,
      });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      const match = /Bearer access-r(\d+)/.exec(bearer(init) ?? "");
      assert.ok(match);
      usageGenerations.push(Number(match[1]));
      return json({ five_hour: { utilization: generation * 10, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: original.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // Keep posting the browser's original R0 snapshot to model a tab left open all day. The service
  // must heal from the authoritative vault and advance the one-time chain on every 8h expiry.
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const result = await getAccountUsage(userId, { ...original, tokens: { ...original.tokens } });
    assert.equal(result.status, "ready", `cycle ${cycle} stayed connected`);
    assert.equal(result.tokens?.refreshToken, `refresh-r${cycle}`);
    assert.equal((await loadAccounts(userId))[0].tokens.refreshToken, `refresh-r${cycle}`);
    now += 8 * 60 * 60_000 + 2 * 60_000;
  }

  assert.equal(tokenCalls, 4);
  assert.deepEqual(usageGenerations, [1, 2, 3, 4]);
});

test("a stale caller uses the authoritative live vault access token without rotating it again", async () => {
  const now = 1_900_100_000_000;
  Date.now = () => now;
  const userId = "stale-caller";
  const current = account("stale", now, {
    accessToken: "access-vault-current",
    refreshToken: "refresh-vault-current",
    expiresAt: now + 8 * 60 * 60_000,
  });
  await saveAccounts(userId, [current]);
  const stalePosted = account("stale", now, {
    accessToken: "access-posted-stale",
    refreshToken: "refresh-posted-stale",
    expiresAt: now - 60_000,
  });

  let tokenCalls = 0;
  let usageAuthorization = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      return json({ access_token: "unexpected", refresh_token: "unexpected", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageAuthorization = bearer(init) ?? "";
      return json({ five_hour: { utilization: 32, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: current.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await getAccountUsage(userId, stalePosted);
  assert.equal(result.status, "ready");
  assert.equal(tokenCalls, 0, "a backgrounded tab must not needlessly spend the vault's newer refresh token");
  assert.equal(usageAuthorization, "Bearer access-vault-current");
  assert.deepEqual((await loadAccounts(userId))[0].tokens, current.tokens);
});

test("manual add never rotates an unsaved credential when its access token is rejected", async () => {
  let tokenCalls = 0;
  let usageCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      return json({ access_token: "must-not-be-used", refresh_token: "must-not-be-used", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageCalls += 1;
      return json({ error: "expired" }, 401);
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: "unsaved" } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () =>
      fetchUsageOnce({
        accessToken: "expired-unsaved-access",
        refreshToken: "single-use-unsaved-refresh",
        expiresAt: Date.now() - 1,
      }),
    /not renewed before being saved.*private app login/i,
  );
  assert.equal(usageCalls, 1);
  assert.equal(tokenCalls, 0, "the unsaved single-use refresh token was never posted");

  await assert.rejects(
    () => fetchUsageOnce({ accessToken: "", refreshToken: "still-must-not-be-used", expiresAt: 0 }),
    /no access token.*private app login/i,
  );
  assert.equal(tokenCalls, 0);
});

test("a dedicated monitor token can verify usage without the identity-only profile scope", async () => {
  let usageCalls = 0;
  let profileCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageCalls += 1;
      return json({ five_hour: { utilization: 27, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) {
      profileCalls += 1;
      return json(
        {
          type: "error",
          error: {
            type: "permission_error",
            message: "OAuth token is missing required permission user:profile",
            permission: "user:profile",
          },
        },
        403,
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await fetchUsageOnce({
    accessToken: "sk-ant-oat01-dedicated",
    refreshToken: null,
    expiresAt: 0,
  });

  assert.equal(result.usage.five_hour?.utilization, 27);
  assert.equal(result.profile, null);
  assert.equal(usageCalls, 1);
  assert.equal(profileCalls, 1);
});

test("rotating credentials still require profile even for the user:profile permission error", async () => {
  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      throw new Error("An unsaved rotating credential must not be renewed");
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      return json({ five_hour: { utilization: 31, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) {
      return json(
        {
          error: {
            type: "permission_error",
            message: "OAuth token is missing required permission user:profile",
            permission: "user:profile",
          },
        },
        403,
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await assert.rejects(
    () =>
      fetchUsageOnce({
        accessToken: "access-rotating",
        refreshToken: "refresh-rotating",
        expiresAt: Date.now() + 60_000,
      }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403);
      return true;
    },
  );
  assert.equal(tokenCalls, 0);
});

test("dedicated tokens do not hide unrelated or unstructured profile 403 responses", async () => {
  const profileResponses = [
    json(
      {
        error: {
          type: "permission_error",
          message: "OAuth token is missing required permission user:email",
          permission: "user:email",
        },
      },
      403,
    ),
    json(
      {
        error: {
          type: "invalid_request_error",
          message: "The user:profile request is invalid",
          permission: "user:profile",
        },
      },
      403,
    ),
    new Response("permission_error: missing user:profile", { status: 403 }),
  ];

  for (const profileResponse of profileResponses) {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes(USAGE_URL_FRAGMENT)) {
        return json({ five_hour: { utilization: 34, resets_at: null } });
      }
      if (url.includes(PROFILE_URL_FRAGMENT)) return profileResponse;
      throw new Error(`Unexpected fetch: ${url}`);
    };

    await assert.rejects(
      () =>
        fetchUsageOnce({
          accessToken: "sk-ant-oat01-dedicated",
          refreshToken: null,
          expiresAt: 0,
        }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 403);
        return true;
      },
    );
  }
});

test("a late R1 persistence cannot overwrite an already-advanced R2 credential", async () => {
  const now = 1_900_150_000_000;
  Date.now = () => now;
  const userId = "late-rotation";
  const original = account("late", now, {
    accessToken: "access-r0",
    refreshToken: "refresh-r0",
    expiresAt: now - 1,
  });
  const alreadyAdvanced = account("late", now, {
    accessToken: "access-r2",
    refreshToken: "refresh-r2",
    // Deliberately equal to R1's normalized expiry: wall-clock expiry is not a safe generation id.
    expiresAt: now + 8 * 60 * 60_000,
  });
  await saveAccounts(userId, [original]);

  let usageAuthorization = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      assert.equal(body.refresh_token, "refresh-r0");
      // Model a second owner that advanced R1 to R2 while this slow R0→R1 request was in flight.
      // When the late response returns, R1 is already stale and must never replace R2.
      await saveAccounts(userId, [alreadyAdvanced]);
      return json({ access_token: "access-r1", refresh_token: "refresh-r1", expires_in: 8 * 60 * 60 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageAuthorization = bearer(init) ?? "";
      return json({ five_hour: { utilization: 37, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: original.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await getAccountUsage(userId, original);
  assert.equal(result.status, "ready");
  assert.equal(usageAuthorization, "Bearer access-r2", "the caller adopted the already-authoritative generation");
  assert.deepEqual((await loadAccounts(userId))[0].tokens, alreadyAdvanced.tokens);
  assert.notEqual(result.tokens?.refreshToken, "refresh-r1", "the stale late generation was not echoed to the browser");
});

test("a transient rotated-token persistence fault is retried and verified before ready", async () => {
  const now = 1_900_200_000_000;
  Date.now = () => now;
  const userId = "transient-persistence";
  const stored = account("transient", now);
  await saveAccounts(userId, [stored]);

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      return json({ access_token: "access-transient-1", refresh_token: "refresh-transient-1", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) return json({ five_hour: { utilization: 43, resets_at: null } });
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const originalRename = fs.rename;
  let renameAttempts = 0;
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    renameAttempts += 1;
    if (renameAttempts === 1) throw Object.assign(new Error("injected transient disk fault"), { code: "EIO" });
    return originalRename(...args);
  }) as typeof fs.rename;
  try {
    const result = await getAccountUsage(userId, stored);
    assert.equal(result.status, "ready");
    assert.ok(renameAttempts >= 2, "rotated-token persistence was retried");
    assert.equal((await loadAccounts(userId))[0].tokens.refreshToken, "refresh-transient-1");
  } finally {
    fs.rename = originalRename;
  }
});

test("persistent vault failure never returns false-ready and carries the rotated pair for emergency recovery", async () => {
  const now = 1_900_300_000_000;
  Date.now = () => now;
  const userId = "persistent-persistence";
  const stored = account("persistent", now);
  await saveAccounts(userId, [stored]);

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      return json({ access_token: "access-persistent-1", refresh_token: "refresh-persistent-1", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) return json({ five_hour: { utilization: 54, resets_at: null } });
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const originalRename = fs.rename;
  let renameAttempts = 0;
  fs.rename = (async () => {
    renameAttempts += 1;
    throw Object.assign(new Error("injected persistent disk fault"), { code: "EIO" });
  }) as typeof fs.rename;
  try {
    const result = await getAccountUsage(userId, stored);
    assert.equal(result.status, "error");
    assert.equal(result.stale, true);
    assert.ok(renameAttempts >= 3, "several bounded durability attempts were made before giving up");
    assert.equal(result.tokens?.accessToken, "access-persistent-1");
    assert.equal(result.tokens?.refreshToken, "refresh-persistent-1");
    assert.equal(result.tokensNeedPersistence, true, "the client is told this exceptional pair still needs durable rescue");
    assert.match(result.error ?? "", /could not be saved/i);
    assert.deepEqual((await loadAccounts(userId))[0].tokens, stored.tokens, "the old vault was not reported as updated");
  } finally {
    fs.rename = originalRename;
  }
});

test("usage rate-limit cooldown serves last-good data and suppresses repeated upstream calls", async () => {
  let now = 1_900_400_000_000;
  Date.now = () => now;
  const userId = "cooldown";
  const stored = account("cooldown", now, {
    expiresAt: now + 24 * 60 * 60_000,
  });
  await saveAccounts(userId, [stored]);

  let usageCalls = 0;
  let rateLimited = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageCalls += 1;
      if (rateLimited) return json({ error: { type: "rate_limit_error", message: "slow down" } }, 429);
      return json({ five_hour: { utilization: 65, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const first = await getAccountUsage(userId, stored);
  assert.equal(first.status, "ready");
  assert.equal(usageCalls, 1);

  now += CACHE_TTL_MS;
  rateLimited = true;
  const limited = await getAccountUsage(userId, stored);
  assert.equal(limited.status, "stale");
  assert.equal(limited.usage?.five_hour?.utilization, 65);
  assert.equal(limited.cooldownUntil, now + COOLDOWN_MS);
  assert.equal(usageCalls, 2);

  now += 60_000;
  const suppressed = await getAccountUsage(userId, stored);
  assert.equal(suppressed.status, "stale");
  assert.equal(suppressed.usage?.five_hour?.utilization, 65);
  assert.equal(usageCalls, 2, "no upstream request was made inside the cooldown window");
});

test("a refresh-endpoint 429 cools down as transient instead of falsely demanding reauthentication", async () => {
  let now = 1_900_500_000_000;
  Date.now = () => now;
  const userId = "refresh-throttle";
  const stored = account("refresh-throttle", now);
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      return json({ error: { type: "rate_limit_error", message: "temporarily throttled" } }, 429);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const first = await getAccountUsage(userId, stored);
  assert.equal(first.status, "error");
  assert.notEqual(first.status, "reauth", "a temporary throttle must not tell the user to reconnect");
  assert.match(first.error ?? "", /temporarily throttled/i);
  assert.equal(first.cooldownUntil, now + COOLDOWN_MS);
  assert.equal(tokenCalls, 1);

  now += 60_000;
  const suppressed = await getAccountUsage(userId, stored);
  assert.notEqual(suppressed.status, "reauth");
  assert.equal(tokenCalls, 1, "the single-use token was not retried inside the cooldown");
});

test("an app-managed login stays recoverable across repeated refresh throttles", async () => {
  let now = 1_900_550_000_000;
  Date.now = () => now;
  const userId = "managed-refresh-throttle";
  const stored: StoredAccount = {
    ...account("managed-refresh-throttle", now, { expiresAt: now + 10 * 60_000 }),
    credentialKind: "managed",
  };
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  let usageCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.refresh_token, stored.tokens.refreshToken);
      assert.equal(body.scope, "user:profile user:inference");
      return json({ error: { type: "rate_limit_error", message: "temporarily throttled" } }, 429);
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageCalls += 1;
      return json({ five_hour: { utilization: 48, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const initial = await getAccountUsage(userId, stored);
  assert.equal(initial.status, "ready");
  assert.equal(initial.usage?.five_hour?.utilization, 48);
  assert.equal(tokenCalls, 0);

  now += 10 * 60_000 + 1;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const throttled = await getAccountUsage(userId, stored);
    assert.equal(throttled.status, "stale", `attempt ${attempt} preserved last-good data`);
    assert.notEqual(throttled.status, "reauth");
    assert.equal(throttled.usage?.five_hour?.utilization, 48);
    assert.equal(throttled.cooldownUntil, now + COOLDOWN_MS);
    assert.match(throttled.error ?? "", /remains connected.*retry after a cooldown/i);
    assert.equal(tokenCalls, attempt);
    if (attempt < 4) now += COOLDOWN_MS + 1;
  }

  now += 60_000;
  const suppressed = await getAccountUsage(userId, stored);
  assert.equal(suppressed.status, "stale");
  assert.equal(tokenCalls, 4, "the managed grant was not retried inside its cooldown");
  assert.equal(usageCalls, 1, "last-good usage stayed available throughout renewal backoff");
  assert.deepEqual((await loadAccounts(userId))[0].tokens, stored.tokens);
});

test("an encrypted recovery journal survives a failed main-vault write and prevents refresh replay", async () => {
  const now = 1_900_600_000_000;
  Date.now = () => now;
  const userId = "journal-recovery";
  const stored = account("journal-recovery", now);
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  let usageCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      assert.equal(JSON.parse(String(init?.body)).refresh_token, stored.tokens.refreshToken);
      return json({ access_token: "access-journal-r1", refresh_token: "refresh-journal-r1", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      usageCalls += 1;
      assert.equal(bearer(init), "Bearer access-journal-r1");
      return json({ five_hour: { utilization: 62, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const mainVault = path.join(dataDir, `vault-${userId}.enc`);
  const originalRename = fs.rename;
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === mainVault) {
      throw Object.assign(new Error("injected main-vault outage"), { code: "EIO" });
    }
    return originalRename(...args);
  }) as typeof fs.rename;
  try {
    const first = await getAccountUsage(userId, stored);
    assert.equal(first.status, "error");
    assert.equal(first.tokensNeedPersistence, true);
    assert.equal(tokenCalls, 1);
    assert.equal(usageCalls, 0);
  } finally {
    fs.rename = originalRename;
  }

  const recovered = await getAccountUsage(userId, stored);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.usage?.five_hour?.utilization, 62);
  assert.equal(tokenCalls, 1, "R0 was not posted again after the process adopted its encrypted R1 journal");
  assert.equal((await loadAccounts(userId))[0].tokens.refreshToken, "refresh-journal-r1");
});

test("a successful refresh commits the replacement to main and backup before clearing its journal", async () => {
  const now = 1_900_650_000_000;
  Date.now = () => now;
  const userId = "rotated-backup-promotion";
  const stored = account("rotated-backup-promotion", now);
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      assert.equal(JSON.parse(String(init?.body)).refresh_token, stored.tokens.refreshToken);
      return json({ access_token: "access-promoted-r1", refresh_token: "refresh-promoted-r1", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) {
      assert.equal(bearer(init), "Bearer access-promoted-r1");
      return json({ five_hour: { utilization: 17, resets_at: null } });
    }
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const refreshed = await getAccountUsage(userId, stored);
  assert.equal(refreshed.status, "ready");
  assert.equal(tokenCalls, 1);
  assert.equal((await loadAccounts(userId))[0].tokens.refreshToken, "refresh-promoted-r1");

  // The main ciphertext can now be restored from its last-known-good copy without rolling back to
  // the already-spent R0 generation, even though the R1 recovery journal has been tombstoned.
  const mainVault = path.join(dataDir, `vault-${userId}.enc`);
  await fs.writeFile(mainVault, "injected-post-refresh-corruption", { mode: 0o600 });
  const restored = await loadAccounts(userId);
  assert.equal(restored[0].tokens.accessToken, "access-promoted-r1");
  assert.equal(restored[0].tokens.refreshToken, "refresh-promoted-r1");
  assert.equal(tokenCalls, 1, "the spent R0 refresh grant was never replayed");
});

test("a 401 from a freshly renewed access token becomes terminal reauth without another rotation", async () => {
  let now = 1_900_700_000_000;
  Date.now = () => now;
  const userId = "replacement-rejected";
  const stored = account("replacement-rejected", now);
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      return json({ access_token: "access-rejected-r1", refresh_token: "refresh-rejected-r1", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) return json({ error: "rejected" }, 401);
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ error: "rejected" }, 401);
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const first = await getAccountUsage(userId, stored);
  assert.equal(first.status, "reauth");
  assert.equal(tokenCalls, 1);
  now += COOLDOWN_MS + 1;
  const later = await getAccountUsage(userId, stored);
  assert.equal(later.status, "reauth");
  assert.equal(tokenCalls, 1, "terminal reauth remained fenced until an explicit reconnect clears it");
});

test("three spaced refresh throttles escalate a likely-spent shared session to reconnect", async () => {
  let now = 1_900_800_000_000;
  Date.now = () => now;
  const userId = "repeated-refresh-throttle";
  const stored = account("repeated-refresh-throttle", now);
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      return json({ error: { type: "rate_limit_error", message: "still throttled" } }, 429);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const first = await getAccountUsage(userId, stored);
  assert.equal(first.status, "error");
  now += COOLDOWN_MS + 1;
  const second = await getAccountUsage(userId, stored);
  assert.equal(second.status, "error");
  now += COOLDOWN_MS + 1;
  const third = await getAccountUsage(userId, stored);
  assert.equal(third.status, "reauth");
  assert.equal(tokenCalls, 3);

  now += COOLDOWN_MS + 1;
  const terminal = await getAccountUsage(userId, stored);
  assert.equal(terminal.status, "reauth");
  assert.equal(tokenCalls, 3);
});

test("a rotating credential with unknown expiry uses its verified access token until a real 401", async () => {
  const now = 1_900_900_000_000;
  Date.now = () => now;
  const userId = "unknown-expiry";
  const stored = account("unknown-expiry", now, { expiresAt: 0 });
  await saveAccounts(userId, [stored]);

  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(TOKEN_URL_FRAGMENT)) {
      tokenCalls += 1;
      return json({ access_token: "unexpected", refresh_token: "unexpected", expires_in: 28_800 });
    }
    if (url.includes(USAGE_URL_FRAGMENT)) return json({ five_hour: { utilization: 18, resets_at: null } });
    if (url.includes(PROFILE_URL_FRAGMENT)) return json({ account: { uuid: stored.id } });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await getAccountUsage(userId, stored);
  assert.equal(result.status, "ready");
  assert.equal(tokenCalls, 0);
});

// os.homedir() follows $HOME on Linux; macOS would consult the developer's real Keychain first.
test(
  "a rejected shared CLI login adopts the CLI's newer local credential instead of going offline",
  { skip: process.platform === "darwin" },
  async () => {
    let now = 1_901_100_000_000;
    Date.now = () => now;
    const userId = "local-self-heal";
    const stored: StoredAccount = { ...account("local-self-heal", now), credentialKind: "rotating" };
    await saveAccounts(userId, [stored]);

    const originalHome = process.env.HOME;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "hmc-self-heal-home-"));
    await fs.mkdir(path.join(home, ".claude"));
    await fs.writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "access-cli-r1", refreshToken: "refresh-cli-r1", expiresAt: now + 3_600_000 },
      }),
    );
    process.env.HOME = home;

    const seen: string[] = [];
    let profileUuid = stored.id;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(TOKEN_URL_FRAGMENT)) {
        seen.push("token");
        return json({ error: "invalid_grant" }, 400);
      }
      if (url.includes(USAGE_URL_FRAGMENT)) {
        seen.push(`usage:${bearer(init)}`);
        return json({ five_hour: { utilization: 5, resets_at: null } });
      }
      if (url.includes(PROFILE_URL_FRAGMENT)) {
        seen.push(`profile:${bearer(init)}`);
        return json({ account: { uuid: profileUuid, email: stored.email } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const healed = await getAccountUsage(userId, stored);
      assert.equal(healed.status, "ready");
      assert.deepEqual(seen.slice(0, 2), ["token", "profile:Bearer access-cli-r1"]);
      assert.ok(seen.includes("usage:Bearer access-cli-r1"));
      assert.equal((await loadAccounts(userId))[0].tokens.refreshToken, "refresh-cli-r1");

      // The local file belongs to a different account: never adopt it, fall through to reauth.
      const other: StoredAccount = { ...account("local-other", now), credentialKind: "rotating" };
      await saveAccounts(userId, [(await loadAccounts(userId))[0], other]);
      profileUuid = "someone-else";
      seen.length = 0;
      now += CACHE_TTL_MS + 1;
      const rejected = await getAccountUsage(userId, other);
      assert.equal(rejected.status, "reauth");
      assert.equal((await loadAccounts(userId))[1].tokens.refreshToken, "refresh-local-other-0");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  },
);
