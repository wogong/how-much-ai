import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { loadAccounts } from "@/lib/vault";
import { syncSub2ApiAccounts } from "@/lib/sub2api";
import { getAccountUsage } from "@/lib/usage-service";
import { extractBars } from "@/lib/format";
import { safeEqual } from "@/lib/session";
import { diffLimit, type LimitReading } from "@/lib/notify-detect";
import {
  claimNotificationRun,
  loadConfig,
  loadStates,
  notifyStorageReady,
  releaseNotificationRun,
  renewNotificationRun,
  saveStates,
  type StoredNotifyState,
} from "@/lib/notify-store";
import { dispatch, type AccountEvent } from "@/lib/notify";
import {
  completeNotificationCycle,
  reconcileNotificationStates,
  type AccountStateObservation,
} from "@/lib/notify-cycle";

// Needs Node crypto (vault decryption) + web-push, so force the Node runtime. Never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface UserCheckResult {
  checked: number;
  limits: number;
  events: number;
  channels: string[];
  push: { sent: number; removed: number; failed: number };
  errors: { user: string; account: string; error: string }[];
}

// Run the whole detect→dispatch cycle for a single tenant's vault. Mirrors the original
// single-tenant flow, now scoped by userId so every tenant is independent.
//
// Usage is fetched through the SAME coalesced path the dashboard uses (getAccountUsage): a shared
// cache + single-flight refresh lock. That is what fixes the single-use-token race — the cron and
// the dashboard can no longer both refresh the same account's token at once. getAccountUsage also
// persists any rotated tokens to the vault itself, so this route no longer does its own token
// bookkeeping; warming the cache here means the dashboard's next poll is served from cache for free.
async function checkUser(userId: string, assertLease: () => Promise<void>): Promise<UserCheckResult> {
  const errors: { user: string; account: string; error: string }[] = [];
  try {
    await syncSub2ApiAccounts(userId);
  } catch (err) {
    errors.push({ user: userId, account: "*", error: `sub2api sync: ${err instanceof Error ? err.message : String(err)}` });
  }
  const accounts = await loadAccounts(userId);

  const [config, states] = await Promise.all([loadConfig(userId), loadStates(userId)]);
  await assertLease();
  const stateByKey = new Map<string, StoredNotifyState>(states.map((s) => [s.key, s]));
  const toggles = { recovery: config.recovery, warning: config.warning, everyReset: config.everyReset };
  const thresholds = { warnThreshold: config.warnThreshold, recoveryThreshold: config.recoveryThreshold };

  const accountEvents: AccountEvent[] = [];
  const nextStates: StoredNotifyState[] = [];
  const observations: AccountStateObservation<StoredNotifyState>[] = [];
  const eventfulStateKeys = new Set<string>();

  for (const account of accounts) {
    await assertLease();
    const result = await getAccountUsage(userId, account);
    if (account.sub2api && result.stale) {
      observations.push({ accountId: account.id, available: false });
      continue;
    }
    if (!result.usage) {
      // reauth / error / another poller mid-refresh with no cached data yet. Record and move on —
      // never retry-storm (getAccountUsage already set any cooldown / reauth state).
      if (result.status !== "loading") {
        errors.push({ user: userId, account: account.email, error: result.error ?? `status: ${result.status}` });
      }
      observations.push({ accountId: account.id, available: false });
      continue;
    }

    const who = account.label || account.email;
    const accountStates: StoredNotifyState[] = [];
    for (const bar of extractBars(result.usage)) {
      const reading: LimitReading = { key: bar.key, label: bar.label, percent: bar.percent, resetsAt: bar.resetsAt };
      const key = `${account.id}::${bar.key}`;
      const { nextState, events } = diffLimit(stateByKey.get(key), reading, toggles, thresholds);
      const storedState = { key, accountId: account.id, limitKey: bar.key, ...nextState };
      nextStates.push(storedState);
      accountStates.push(storedState);
      if (events.length > 0) eventfulStateKeys.add(key);
      for (const event of events) accountEvents.push({ event, accountLabel: who, accountId: account.id });
    }
    observations.push({ accountId: account.id, available: true, states: accountStates });
  }

  const stateSnapshot = reconcileNotificationStates(
    states,
    new Set(accounts.map((account) => account.id)),
    observations,
  );

  await assertLease();
  const cycle = await completeNotificationCycle({
    userId,
    events: accountEvents,
    states: stateSnapshot,
    previousStates: states,
    eventfulStateKeys,
    dispatchEvents: dispatch,
    persistStates: async (tenant, snapshot) => {
      // Renew immediately before the state commit. If another worker ever reclaimed the lease, the
      // stale worker is fenced out and cannot advance detector state behind its replacement.
      await assertLease();
      await saveStates(tenant, snapshot);
    },
  });
  for (const failure of cycle.errors) {
    errors.push({
      user: userId,
      account: "*",
      error: `${failure.stage === "delivery" ? "notification delivery" : "notification state"}: ${failure.error}`,
    });
  }

  return {
    checked: accounts.length,
    limits: nextStates.length,
    events: accountEvents.length,
    channels: cycle.dispatch.channels,
    push: cycle.dispatch.push,
    errors,
  };
}

function notificationLeaseGuard(userId: string, owner: string) {
  let stopped = false;
  let lost = false;
  let renewal: Promise<boolean> | null = null;

  const renew = async (): Promise<boolean> => {
    if (stopped) return !lost;
    if (!renewal) {
      renewal = renewNotificationRun(userId, owner)
        .catch(() => false)
        .finally(() => {
          renewal = null;
        });
    }
    const retained = await renewal;
    if (!retained) lost = true;
    return retained;
  };

  // Keep a long-running tenant pass fenced even when it has many accounts or push targets.
  const timer = setInterval(() => void renew(), 60_000);
  timer.unref();

  return {
    assert: async () => {
      if (lost || !(await renew())) throw new Error("Notification run lease was lost");
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (renewal) await renewal;
    },
  };
}

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  const provided = req.headers.get("x-cron-secret") ?? "";
  // Constant-time compare (same helper the password login uses) to avoid leaking the secret via timing.
  if (!safeEqual(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!notifyStorageReady()) {
    return NextResponse.json(
      { error: "Notifications need Convex — set CONVEX_URL and VAULT_ACCESS_SECRET" },
      { status: 503 },
    );
  }

  // The open-source edition is deliberately single-tenant. Never enumerate namespaced vault rows:
  // this also prevents a mistakenly shared backend from exposing or processing another app's users.
  const userIds = ["default"];

  let checked = 0;
  let limits = 0;
  let events = 0;
  let skipped = 0;
  const channels = new Set<string>();
  const push = { sent: 0, removed: 0, failed: 0 };
  const errors: { user: string; account: string; error: string }[] = [];

  for (const userId of userIds) {
    const owner = randomUUID();
    let acquired = false;
    let guard: ReturnType<typeof notificationLeaseGuard> | null = null;
    try {
      const claim = await claimNotificationRun(userId, owner);
      if (!claim.acquired) {
        skipped++;
        continue;
      }
      acquired = true;
      guard = notificationLeaseGuard(userId, owner);
      const r = await checkUser(userId, guard.assert);
      checked += r.checked;
      limits += r.limits;
      events += r.events;
      for (const ch of r.channels) channels.add(ch);
      push.sent += r.push.sent;
      push.removed += r.push.removed;
      push.failed += r.push.failed;
      errors.push(...r.errors);
    } catch (err) {
      errors.push({ user: userId, account: "*", error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (guard) await guard.stop();
      if (acquired) {
        try {
          await releaseNotificationRun(userId, owner);
        } catch (err) {
          errors.push({
            user: userId,
            account: "*",
            error: err instanceof Error ? `Couldn't release notification lease: ${err.message}` : "Couldn't release notification lease",
          });
        }
      }
    }
  }

  return NextResponse.json({
    users: userIds.length,
    checked,
    limits,
    events,
    skipped,
    dispatched: [...channels],
    push,
    errors,
  });
}
