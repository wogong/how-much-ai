import { createHash } from "node:crypto";
import { normalizeSub2ApiUrl, validSub2ApiAccountId } from "./sub2api-config";
import { openaiPlanLabel } from "./providers/openai";
import { ProviderError, type Provider, type ProviderId } from "./providers/types";
import type { StoredAccount, UsageBucket, UsageData } from "./types";
import { loadAccounts, mutateAccounts } from "./vault";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export interface Sub2ApiAccountInfo {
  accountId: number;
  name: string;
  email: string;
  plan: string;
  provider: ProviderId;
}

export class Sub2ApiError extends ProviderError {}

// Automatic reads use metadata; explicit refresh uses /usage, which may probe upstream.
// The account credential /refresh endpoint is never called.
async function request(baseUrl: string, adminKey: string, path: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${normalizeSub2ApiUrl(baseUrl)}/api/v1/admin/accounts${path}`, {
      method: "GET",
      headers: { "x-api-key": adminKey, Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Sub2ApiError("Couldn't reach sub2api. Check its URL and network access; redirects are not followed.", 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 401 || response.status === 403
      ? "sub2api rejected the admin key. Reconnect using an Admin API Key."
      : response.status === 404
        ? "The sub2api account or API endpoint was not found."
        : `sub2api returned HTTP ${response.status}.`;
    throw new Sub2ApiError(message, response.status);
  }
  // Bound responses too: account lists may be large and must never become an unbounded buffer.
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const envelope = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (envelope.code !== 0 || !("data" in envelope)) throw new Error();
    return envelope.data;
  } catch {
    // Never reflect a remote response, which can contain credentials or an HTML proxy error.
    throw new Sub2ApiError("sub2api returned an unsupported or oversized response.", 502);
  }
}

function text(value: unknown, fallback: string, max = 200): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function accountInfo(raw: unknown): Sub2ApiAccountInfo | null {
  const account = object(raw);
  if (!validSub2ApiAccountId(account.id)) return null;
  const provider = account.platform;
  if (provider !== "anthropic" && provider !== "openai") return null;
  if (account.type !== "oauth" && !(provider === "anthropic" && account.type === "setup-token")) return null;
  const credentials = object(account.credentials);
  const name = text(account.name, `Account ${account.id}`);
  return {
    accountId: account.id,
    name,
    email: text(credentials.email, name, 512),
    plan: provider === "openai" ? openaiPlanLabel(text(credentials.plan_type, "")) : "Claude",
    provider,
  };
}

export async function listSub2ApiAccounts(baseUrl: string, adminKey: string, page: number, provider?: ProviderId, signal?: AbortSignal) {
  const data = object(await request(baseUrl, adminKey, `?page=${page}&page_size=50${provider ? `&platform=${provider}` : ""}`, signal));
  if (!Array.isArray(data.items) || typeof data.total !== "number" || !Number.isFinite(data.total) || data.total < 0) {
    throw new Sub2ApiError("sub2api returned an unsupported account list.", 502);
  }
  return {
    accounts: data.items.map(accountInfo).filter((item): item is Sub2ApiAccountInfo => item !== null && (!provider || item.provider === provider)),
    hasMore: page * 50 < data.total,
  };
}

async function readAccount(baseUrl: string, adminKey: string, id: number) {
  const raw = object(await request(baseUrl, adminKey, `/${id}`));
  const info = accountInfo(raw);
  if (!info || info.accountId !== id) throw new Sub2ApiError("This sub2api account is not a supported Claude or ChatGPT subscription account.", 422);
  return { raw, info };
}

export function sub2ApiAccountId(baseUrl: string, accountId: number): string {
  const instance = createHash("sha256").update(normalizeSub2ApiUrl(baseUrl)).digest("hex").slice(0, 24);
  return `sub2api-${instance}-${accountId}`;
}

export async function connectSub2ApiAccount(baseUrl: string, adminKey: string, accountId: number): Promise<StoredAccount> {
  const { info } = await readAccount(baseUrl, adminKey, accountId);
  return buildSub2ApiAccount(baseUrl, adminKey, info);
}

// Gather every page before committing, so a failed page cannot leave a partial import.
export async function connectAllSub2ApiAccounts(baseUrl: string, adminKey: string): Promise<StoredAccount[]> {
  const accounts = new Map<number, StoredAccount>();
  const signal = AbortSignal.timeout(25_000);
  for (let page = 1; page <= 100; page++) {
    const result = await listSub2ApiAccounts(baseUrl, adminKey, page, undefined, signal);
    for (const info of result.accounts) accounts.set(info.accountId, buildSub2ApiAccount(baseUrl, adminKey, info));
    if (accounts.size > 500) throw new Sub2ApiError("The dashboard supports at most 500 accounts. Connect individual accounts instead.", 422);
    if (!result.hasMore) return [...accounts.values()];
  }
  throw new Sub2ApiError("The sub2api list is too large. Connect individual accounts instead.", 422);
}

// Discover accounts added in sub2api since connection. Append-only: accounts removed upstream keep
// their nickname and surface as a refresh error instead of vanishing. Runs at most once per
// instance per interval in this process, so vault reads and cron passes stay cheap.
// Opt-in via SUB2API_AUTO_SYNC=1; otherwise only explicit connect actions add accounts.
const SYNC_INTERVAL_MS = 10 * 60_000;
const lastSyncAt = new Map<string, number>();

export async function syncSub2ApiAccounts(userId: string, opts?: { force?: boolean }): Promise<{ added: number }> {
  if (process.env.SUB2API_AUTO_SYNC !== "1") return { added: 0 };
  const existing = await loadAccounts(userId);
  const instances = new Map<string, string>();
  for (const account of existing) {
    if (account.sub2api && !instances.has(account.sub2api.baseUrl)) instances.set(account.sub2api.baseUrl, account.tokens.accessToken);
  }
  let added = 0;
  for (const [baseUrl, adminKey] of instances) {
    const key = `${userId}\0${baseUrl}`;
    const now = Date.now();
    if (!opts?.force && now - (lastSyncAt.get(key) ?? 0) < SYNC_INTERVAL_MS) continue;
    lastSyncAt.set(key, now);
    const discovered = await connectAllSub2ApiAccounts(baseUrl, adminKey);
    await mutateAccounts(userId, current => {
      const known = new Set(current.map(account => account.id));
      const fresh = discovered.filter(account => !known.has(account.id));
      if (!fresh.length) return current;
      if (current.length + fresh.length > 500) throw new Sub2ApiError("Syncing sub2api would exceed the dashboard's 500-account limit.", 422);
      added += fresh.length;
      return [...current, ...fresh];
    });
  }
  return { added };
}

function buildSub2ApiAccount(baseUrl: string, adminKey: string, info: Sub2ApiAccountInfo): StoredAccount {
  return {
    id: sub2ApiAccountId(baseUrl, info.accountId),
    email: info.email,
    fullName: info.name,
    plan: info.plan,
    provider: info.provider,
    addedAt: Date.now(),
    credentialKind: "long_lived",
    sub2api: { baseUrl: normalizeSub2ApiUrl(baseUrl), accountId: info.accountId },
    // Externally managed credentials have no local expiry/rotation. The provider capability
    // prevents this sentinel expiry from ever entering upstream token-refresh machinery.
    tokens: { accessToken: adminKey, refreshToken: null, expiresAt: 0 },
  };
}

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = numeric(value);
  const ms = number !== null ? number * 1000 : Date.parse(String(value));
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : null;
}

// Only measured values are mapped. Missing or expired windows remain unknown, never inferred 0%.
// Claude snapshot values are fractions; Codex values are percentages.
export function normalizeSub2ApiSnapshot(raw: JsonObject, provider: ProviderId, now = Date.now()): UsageData {
  const extra = object(raw.extra);
  const sampled = timestamp(extra[provider === "openai" ? "codex_usage_updated_at" : "passive_usage_sampled_at"]);
  const usage: UsageData = { snapshot: { source: "sub2api", sampledAt: sampled ? new Date(sampled).toISOString() : null } };
  const bucket = (value: unknown, reset: unknown, factor = 1): UsageBucket | undefined => {
    const percent = numeric(value);
    const resets = timestamp(reset);
    if (percent === null || !Number.isFinite(percent * factor) || (resets !== null && resets <= now)) return undefined;
    return { utilization: percent * factor, resets_at: resets ? new Date(resets).toISOString() : null };
  };
  if (provider === "openai") {
    for (const [window, key] of [["5h", "five_hour"], ["7d", "seven_day"]] as const) {
      let reset = timestamp(extra[`codex_${window}_reset_at`]);
      const remaining = numeric(extra[`codex_${window}_reset_after_seconds`]);
      if (reset === null && sampled !== null && remaining !== null) reset = sampled + remaining * 1000;
      const value = bucket(extra[`codex_${window}_used_percent`], reset === null ? null : reset / 1000);
      if (value) usage[key] = value;
    }
  } else {
    const session = bucket(extra.session_window_utilization, raw.session_window_end, 100);
    const weekly = bucket(extra.passive_usage_7d_utilization, extra.passive_usage_7d_reset, 100);
    if (session) usage.five_hour = session;
    if (weekly) usage.seven_day = weekly;
  }
  return usage;
}

// Preserve the upstream provider identity/presentation while replacing its credential lifecycle.
export function sub2ApiProvider(provider: Provider, connection: NonNullable<StoredAccount["sub2api"]>): Provider {
  return {
    id: provider.id,
    label: provider.label,
    supportsOAuth: false,
    managesCredentialsExternally: true,
    async refresh() { throw new Sub2ApiError("Reconnect sub2api to replace its admin key.", 401); },
    async resolveIdentity(tokens) {
      const { info } = await readAccount(connection.baseUrl, tokens.accessToken, connection.accountId);
      return { id: sub2ApiAccountId(connection.baseUrl, connection.accountId), ...info };
    },
    async fetchUsage(tokens, opts) {
      let { raw, info } = await readAccount(connection.baseUrl, tokens.accessToken, connection.accountId);
      if (info.provider !== provider.id) throw new Sub2ApiError("The sub2api account's provider changed. Remove and reconnect it.", 422);
      if (!opts?.activeRefresh) return normalizeSub2ApiSnapshot(raw, provider.id);

      const active = object(await request(connection.baseUrl, tokens.accessToken,
        `/${connection.accountId}/usage?source=active&force=true`, undefined, 45_000));
      if (active.error || active.error_code) {
        throw new Sub2ApiError("sub2api could not refresh upstream usage. Check this account in sub2api.", 502);
      }
      // Codex can return placeholder 0% windows and a new updated_at even when probing failed.
      // Reread the persisted snapshot; only its actual sample time establishes freshness.
      ({ raw, info } = await readAccount(connection.baseUrl, tokens.accessToken, connection.accountId));
      if (info.provider !== provider.id) throw new Sub2ApiError("The sub2api account's provider changed. Remove and reconnect it.", 422);
      let usage = normalizeSub2ApiSnapshot(raw, provider.id);
      if (provider.id === "anthropic" && raw.type === "oauth" && active.source !== "passive") {
        const sampled = timestamp(active.updated_at);
        if (sampled !== null) {
          const now = Date.now();
          const measured: UsageData = {};
          for (const key of ["five_hour", "seven_day", "seven_day_sonnet"] as const) {
            const window = object(active[key]);
            const percent = numeric(window.utilization);
            const reset = timestamp(window.resets_at);
            if (percent !== null && (reset === null || reset > now)) {
              measured[key] = { utilization: percent, resets_at: reset ? new Date(reset).toISOString() : null };
            }
          }
          if (Object.keys(measured).length) {
            usage = { ...measured, snapshot: { source: "sub2api", sampledAt: new Date(sampled).toISOString() } };
          }
        }
      }
      usage.snapshot!.refreshCompletedAt = Date.now();
      return usage;
    },
  };
}
