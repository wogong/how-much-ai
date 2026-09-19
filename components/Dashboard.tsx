"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AccountSnapshot, BrowserAccount, UsageResponse, VaultMutation } from "@/lib/types";
import type { ProviderId } from "@/lib/providers/types";
import { loadSettings, saveSettings } from "@/lib/storage";
import {
  archiveUnreadableVault,
  fetchVault,
  persistVaultMutations,
  VaultRequestError,
  type VaultSnapshot,
} from "@/lib/vault-client";
import { extractBars, formatClock, planLabel } from "@/lib/format";
import { AccountCard, accountDisplayName } from "@/components/AccountCard";
import { PROVIDER_ORDER, providerMeta } from "@/components/providers-ui";
import { AddAccountModal } from "@/components/AddAccountModal";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { SignOutButton } from "@/components/SignOutButton";
import { BellIcon, PlusIcon, RefreshIcon, StarburstIcon } from "@/components/Icons";
import {
  dashboardVaultReducer,
  initialDashboardVaultState,
} from "@/components/dashboard-vault-state";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function errText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

interface DashboardProps {
  showSignOut: boolean;
}

export function Dashboard({ showSignOut }: DashboardProps) {
  const [accounts, setAccounts] = useState<BrowserAccount[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, AccountSnapshot>>({});
  const [vaultUi, dispatchVaultUi] = useReducer(dashboardVaultReducer, initialDashboardVaultState);
  const {
    status: vaultState,
    error: vaultError,
    errorCode: vaultErrorCode,
    recoveryConfirm: vaultRecoveryConfirm,
    recoveryError: vaultRecoveryError,
  } = vaultUi;
  const [vaultRecoveryBusy, setVaultRecoveryBusy] = useState(false);
  const [vaultRecoveryNotice, setVaultRecoveryNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reconnectAccount, setReconnectAccount] = useState<BrowserAccount | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [providerFilter, setProviderFilter] = useState<ProviderId | "all">("all");
  const [lastRefreshAll, setLastRefreshAll] = useState<{ at: number; updated: number; total: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const accountsRef = useRef<BrowserAccount[]>([]);
  accountsRef.current = accounts;
  const snapshotsRef = useRef<Record<string, AccountSnapshot>>({});
  snapshotsRef.current = snapshots;
  const serverVaultRef = useRef<VaultSnapshot | null>(null);
  const failedMutationsRef = useRef<VaultMutation[]>([]);
  const persistChain = useRef<Promise<void>>(Promise.resolve());
  const saveRevision = useRef(0);
  const vaultReadGeneration = useRef(0);
  const explicitVaultReads = useRef(0);
  const addAccountButtonRef = useRef<HTMLButtonElement>(null);
  // Per-account in-flight lock: refresh tokens are single-use, so two concurrent refreshes
  // of the same account would double-spend the token.
  const inFlight = useRef<Set<string>>(new Set());
  const now = useNow(30_000);
  const vaultUnreadable = vaultErrorCode === "VAULT_UNREADABLE";

  const adoptSuccessfulVaultSnapshot = useCallback((snapshot: VaultSnapshot) => {
    serverVaultRef.current = snapshot;
    accountsRef.current = snapshot.accounts;
    setAccounts(snapshot.accounts);
    dispatchVaultUi({ type: "load_succeeded" });
    setSyncError(null);
  }, []);

  const queueSave = useCallback((mutation?: VaultMutation) => {
    const revision = ++saveRevision.current;
    setSaveState("saving");
    setSaveError(null);
    const operation = persistChain.current.catch(() => {}).then(async () => {
      const mutations = [...failedMutationsRef.current, ...(mutation ? [mutation] : [])];
      failedMutationsRef.current = [];
      let snapshot = serverVaultRef.current ?? (await fetchVault());

      for (let index = 0; index < mutations.length; index += 1) {
        try {
          snapshot = await persistVaultMutations(snapshot, [mutations[index]]);
          serverVaultRef.current = snapshot;
        } catch (error) {
          // Retain this edit and every later queued edit. A retry replays their semantic patches;
          // idempotency also covers the case where a network response was lost after a valid save.
          failedMutationsRef.current = [...mutations.slice(index), ...failedMutationsRef.current];
          throw error;
        }
      }
      return snapshot;
    });
    persistChain.current = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.then(
      (snapshot) => {
        if (revision !== saveRevision.current) return;
        accountsRef.current = snapshot.accounts;
        setAccounts(snapshot.accounts);
        setSaveState("idle");
      },
      (error) => {
        if (revision !== saveRevision.current) return;
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : "Couldn't save your account changes.");
      },
    );
  }, []);

  const loadVault = useCallback(async () => {
    const readGeneration = ++vaultReadGeneration.current;
    explicitVaultReads.current += 1;
    dispatchVaultUi({ type: "load_started" });
    setSyncError(null);
    try {
      const snapshot = await fetchVault();
      if (readGeneration !== vaultReadGeneration.current) return false;
      adoptSuccessfulVaultSnapshot(snapshot);
      setSaveState("idle");
      setSaveError(null);
      return true;
    } catch (error) {
      if (readGeneration !== vaultReadGeneration.current) return false;
      dispatchVaultUi({
        type: "load_failed",
        error: error instanceof Error ? error.message : "Couldn't load your saved accounts.",
        errorCode: error instanceof VaultRequestError ? error.errorCode ?? null : null,
      });
      return false;
    } finally {
      explicitVaultReads.current = Math.max(0, explicitVaultReads.current - 1);
    }
  }, [adoptSuccessfulVaultSnapshot]);

  const recoverUnreadableVault = useCallback(async () => {
    if (vaultRecoveryBusy) return;
    setVaultRecoveryBusy(true);
    dispatchVaultUi({ type: "recovery_started" });
    try {
      const recovery = await archiveUnreadableVault();
      const loaded = await loadVault();
      if (!loaded) throw new Error("The old vault was archived, but the new empty vault couldn't be loaded.");
      setActionError(null);
      setVaultRecoveryNotice(
        recovery.backupArchive
          ? `The unreadable vault was preserved as ${recovery.archive}, and its unreadable last-known-good backup was preserved as ${recovery.backupArchive}. You can now connect your accounts again.`
          : `The unreadable vault was preserved as ${recovery.archive}. You can now connect your accounts again.`,
      );
    } catch (error) {
      dispatchVaultUi({
        type: "recovery_failed",
        error: error instanceof Error ? error.message : "Couldn't start a fresh vault safely.",
      });
    } finally {
      setVaultRecoveryBusy(false);
    }
  }, [loadVault, vaultRecoveryBusy]);

  useEffect(() => {
    setAutoRefresh(loadSettings().autoRefresh);
    void loadVault();
  }, [loadVault]);

  useEffect(() => {
    if (vaultState !== "ready") return;
    if (!saveSettings({ autoRefresh })) {
      setPreferenceError("Couldn't save the auto-refresh preference on this device.");
    } else {
      setPreferenceError(null);
    }
  }, [autoRefresh, vaultState]);

  const refreshAccount = useCallback(
    async (id: string, manual = false): Promise<boolean> => {
      if (inFlight.current.has(id)) return false;
      const existingSnapshot = snapshotsRef.current[id];
      if (
        existingSnapshot?.status === "reauth" ||
        (existingSnapshot?.cooldownUntil ?? 0) > Date.now()
      ) {
        return false;
      }
      inFlight.current.add(id);
      try {
        if (!accountsRef.current.some((account) => account.id === id)) return false;
        setSnapshots((prev) => ({ ...prev, [id]: { ...prev[id], status: "loading" } }));

        // Send the account id so the server can key its shared cache + single-flight refresh lock
        // (lib/usage-service). The refresh token is single-use, so this coordination — not the
        // client — is what stops the dashboard and the cron from racing it.
        const res = await fetch("/api/usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: id, activeRefresh: manual && accountsRef.current.find(a => a.id === id)?.source === "sub2api" }),
        });

        // A 401 here means the app session expired (not the Claude token) — go re-authenticate.
        if (res.status === 401) {
          window.location.href = "/login";
          return false;
        }
        const data: UsageResponse & { error?: string } = await res.json().catch(() => ({}) as never);
        if (!res.ok) {
          setSnapshots((prev) => ({
            ...prev,
            [id]: {
              ...prev[id],
              status: "error",
              error: errText(data.error, `Usage request failed (${res.status}).`),
              cooldownUntil: data.cooldownUntil,
              stale: data.stale,
            },
          }));
          return false;
        }

        // Rotation and recovery are completed inside the coordinated server path. The response is
        // deliberately credential-free, so this tab only updates usage and display metadata.
        if (!accountsRef.current.some((a) => a.id === id)) return false;

        // Dead token: the account must be re-added. Never retry-storm (the server is in cooldown).
        if (data.status === "reauth") {
          setSnapshots((prev) => ({
            ...prev,
            [id]: { ...prev[id], status: "reauth", error: data.error, cooldownUntil: data.cooldownUntil, stale: true },
          }));
          return false;
        }

        // No usage to show: either a hard error, or another poller is mid-refresh (loading) with no
        // cached value yet — in the latter case keep the current view and let the next poll resolve it.
        if (!data.usage) {
          if (data.status === "error" || data.error) {
            setSnapshots((prev) => ({
              ...prev,
              [id]: {
                ...prev[id],
                status: "error",
                error: errText(data.error, "Couldn't load usage."),
                cooldownUntil: data.cooldownUntil,
                stale: data.stale,
              },
            }));
          } else {
            setSnapshots((prev) => ({
              ...prev,
              [id]: prev[id]?.usage
                ? { ...prev[id], status: "ready", stale: true }
                : { ...prev[id], status: "error", error: "Usage is still refreshing — retry in a moment." },
            }));
          }
          return false;
        }
        const usage = data.usage;

        const cur = accountsRef.current.find((a) => a.id === id)!;
        // Refresh identity/plan only from providers that return a profile (Anthropic). OpenAI keeps
        // its connect-time metadata — data.profile is null — so this refresh is skipped entirely.
        if (data.profile) {
          const plan = planLabel(data.profile);
          const nextEmail = data.profile.account?.email ?? cur.email;
          const nextName = data.profile.account?.full_name ?? cur.fullName;
          const nextPlan = plan === "Claude" ? cur.plan : plan;
          // Only write to the vault when something persisted actually changed.
          if (nextEmail !== cur.email || nextName !== cur.fullName || nextPlan !== cur.plan) {
            const mutation: VaultMutation = {
              op: "update_metadata",
              accountId: id,
              ...(nextEmail !== cur.email ? { email: nextEmail } : {}),
              ...(nextName !== cur.fullName ? { fullName: nextName ?? null } : {}),
              ...(nextPlan !== cur.plan ? { plan: nextPlan } : {}),
            };
            const nextAccounts = accountsRef.current.map((account) =>
              account.id === id
                ? {
                    ...account,
                    email: nextEmail,
                    ...(nextName === undefined ? { fullName: undefined } : { fullName: nextName }),
                    plan: nextPlan,
                  }
                : account,
            );
            accountsRef.current = nextAccounts;
            setAccounts(nextAccounts);
            queueSave(mutation);
          }
        }
        setSnapshots((prev) => ({
          ...prev,
          [id]: {
            status: "ready",
            usage,
            error: data.error,
            profile: data.profile,
            // Stale = the server served its last-good reading during an upstream cooldown; keep the
            // original fetch time so the card can say how old it is.
            fetchedAt: data.fetchedAt ?? Date.now(),
            stale: !!data.stale,
            cooldownUntil: data.cooldownUntil,
          },
        }));
        return !data.stale;
      } catch {
        if (accountsRef.current.some((a) => a.id === id)) {
          setSnapshots((prev) => ({
            ...prev,
            [id]: { ...prev[id], status: "error", error: "Network error — is the connection up?" },
          }));
        }
        return false;
      } finally {
        inFlight.current.delete(id);
      }
    },
    [queueSave],
  );

  const refreshAll = useCallback(async (manual = false) => {
    const ids = accountsRef.current.map((a) => a.id);
    if (ids.length === 0) return;
    const results = await Promise.all(ids.map((id) => refreshAccount(id, manual)));
    setLastRefreshAll({ at: Date.now(), updated: results.filter(Boolean).length, total: ids.length });
  }, [refreshAccount]);

  // The local + pairing connect flows add the account to the vault SERVER-side (never handing the
  // token to the browser), so after one succeeds we re-pull the vault and refresh the newcomer.
  const reloadVault = useCallback(async () => {
    let explicitReadStarted = false;
    let readGeneration: number | null = null;
    try {
      await persistChain.current;
      readGeneration = ++vaultReadGeneration.current;
      explicitVaultReads.current += 1;
      explicitReadStarted = true;
      const snapshot = await fetchVault();
      if (readGeneration !== vaultReadGeneration.current) return;
      adoptSuccessfulVaultSnapshot(snapshot);
      // A connection route may have replaced credentials without changing visible metadata. Reset
      // every returned account rather than comparing secrets the browser no longer receives.
      const resetSnapshots = Object.fromEntries(
        snapshot.accounts.map((account) => [account.id, { status: "idle" as const }]),
      );
      snapshotsRef.current = resetSnapshots;
      setSnapshots(resetSnapshots);
      void Promise.all(snapshot.accounts.map((a) => refreshAccount(a.id)));
    } catch (error) {
      if (readGeneration !== null && readGeneration !== vaultReadGeneration.current) return;
      const message = error instanceof Error ? error.message : "Couldn't reload saved accounts.";
      setSyncError(message);
      throw error;
    } finally {
      if (explicitReadStarted) explicitVaultReads.current = Math.max(0, explicitVaultReads.current - 1);
    }
  }, [adoptSuccessfulVaultSnapshot, refreshAccount]);

  useEffect(() => {
    if (vaultState === "ready") void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultState]);

  useEffect(() => {
    if (vaultState !== "ready" || !autoRefresh) return;
    // Every minute — cheap now that reads are served from the shared server cache (upstream is still
    // only hit at most once per 5 min per account). The local countdown ticks between polls.
    const t = setInterval(() => void refreshAll(), 60_000);
    return () => clearInterval(t);
  }, [vaultState, autoRefresh, refreshAll]);

  // Cross-device sync: when this tab regains focus, pull the latest vault (unless a refresh
  // is mid-flight, to avoid clobbering a just-rotated token before it's persisted).
  useEffect(() => {
    const onFocus = () => {
      if (inFlight.current.size > 0 || saveState === "saving") return;
      if (saveState !== "idle") return;
      if (explicitVaultReads.current > 0) return;
      const revisionAtStart = saveRevision.current;
      const readGeneration = ++vaultReadGeneration.current;
      fetchVault()
        .then((snapshot) => {
          // A user edit may have started while this GET was in flight. Its response is then only a
          // historical snapshot; the queued conditional save will merge against the real latest copy.
          if (
            readGeneration !== vaultReadGeneration.current ||
            revisionAtStart !== saveRevision.current ||
            inFlight.current.size > 0
          ) return;
          adoptSuccessfulVaultSnapshot(snapshot);
        })
        .catch((error) => {
          if (readGeneration !== vaultReadGeneration.current) return;
          setSyncError(error instanceof Error ? error.message : "Couldn't sync saved accounts.");
        });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [adoptSuccessfulVaultSnapshot, saveState]);

  // Add-account entry point. Self-hosted installs are always unlimited.
  const handleAddClick = useCallback(() => {
    setActionError(null);
    if (vaultState !== "ready") {
      setActionError(
        vaultState === "error"
          ? vaultUnreadable
            ? "Reloading cannot unlock the saved vault. Use the recovery options below, or restore its previous encryption secret."
            : `Saved accounts are unavailable: ${vaultError ?? "retry loading below."}`
          : "Checking saved accounts…",
      );
      return;
    }
    setReconnectAccount(null);
    setModalOpen(true);
  }, [vaultError, vaultState, vaultUnreadable]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setReconnectAccount(null);
  }, []);

  const reconnect = useCallback((account: BrowserAccount) => {
    setReconnectAccount(account);
    setModalOpen(true);
  }, []);

  const closeNotifications = useCallback(() => setNotifyOpen(false), []);

  const removeAccount = useCallback(
    (id: string) => {
      inFlight.current.delete(id);
      const next = accountsRef.current.filter((account) => account.id !== id);
      accountsRef.current = next;
      setAccounts(next);
      queueSave({ op: "remove", accountId: id });
      setSnapshots((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      requestAnimationFrame(() => addAccountButtonRef.current?.focus({ preventScroll: true }));
    },
    [queueSave],
  );

  const renameAccount = useCallback(
    (id: string, label: string | undefined) => {
      const normalized = label?.trim() || undefined;
      const current = accountsRef.current.find((account) => account.id === id);
      if (!current || current.label === normalized) return;
      const next = accountsRef.current.map((account) =>
        account.id === id ? { ...account, label: normalized } : account,
      );
      accountsRef.current = next;
      setAccounts(next);
      queueSave({ op: "rename", accountId: id, label: normalized ?? null });
    },
    [queueSave],
  );

  const refreshing = accounts.some((a) => snapshots[a.id]?.status === "loading");

  // When every connected account uses one provider, the page adopts that provider's theme. Mixed or
  // empty dashboards stay neutral; individual cards always retain their own provider theme.
  const pageProvider = useMemo<ProviderId>(() => {
    if (accounts.length === 0) return "anthropic";
    const first = accounts[0].provider ?? "anthropic";
    return accounts.every((a) => (a.provider ?? "anthropic") === first) ? first : "anthropic";
  }, [accounts]);

  // Header copy follows one connected provider; mixed or empty dashboards use the neutral "AI".
  const monitorLabel = useMemo(() => {
    const present = new Set(accounts.map((a) => a.provider ?? "anthropic"));
    return present.size === 1 ? providerMeta([...present][0]).label : "AI";
  }, [accounts]);

  // Provider filter for the card grid and summary tiles. Only offered when both providers are
  // connected; a filter whose provider disappears falls back to showing everything.
  const connectedProviders = useMemo(
    () => PROVIDER_ORDER.filter((id) => accounts.some((a) => (a.provider ?? "anthropic") === id)),
    [accounts],
  );
  const activeFilter = providerFilter !== "all" && connectedProviders.includes(providerFilter) ? providerFilter : "all";
  const visibleAccounts = useMemo(
    () => (activeFilter === "all" ? accounts : accounts.filter((a) => (a.provider ?? "anthropic") === activeFilter)),
    [accounts, activeFilter],
  );

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-provider");
    root.setAttribute("data-provider", pageProvider);
    return () => {
      if (previous === null) root.removeAttribute("data-provider");
      else root.setAttribute("data-provider", previous);
    };
  }, [pageProvider]);

  const stats = useMemo(() => {
    let peakSession: { percent: number; displayName: string } | null = null;
    let peakWeekly: { percent: number; displayName: string } | null = null;
    for (const account of visibleAccounts) {
      const usage = snapshots[account.id]?.usage;
      if (!usage) continue;
      for (const bar of extractBars(usage)) {
        const isSession = bar.key.startsWith("session") || bar.key === "five_hour";
        const target = isSession ? peakSession : peakWeekly;
        if (!target || bar.percent > target.percent) {
          const entry = { percent: bar.percent, displayName: accountDisplayName(account) };
          if (isSession) peakSession = entry;
          else peakWeekly = entry;
        }
      }
    }
    return { peakSession, peakWeekly };
  }, [visibleAccounts, snapshots]);

  const retrySave = useCallback(() => queueSave(), [queueSave]);
  const retryPreference = useCallback(() => {
    if (saveSettings({ autoRefresh })) setPreferenceError(null);
  }, [autoRefresh]);

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#dashboard-main" className="skip-link">
        Skip to dashboard content
      </a>
      <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-3 py-3 sm:gap-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <StarburstIcon className="h-5 w-5 shrink-0 text-coral sm:h-6 sm:w-6" />
            <div>
              <h1 className="sr-only">{monitorLabel} usage monitor</h1>
              <p aria-hidden="true" className="font-display hidden text-lg leading-none text-ivory xs:block sm:text-xl">How Much AI</p>
              <p className="mt-0.5 hidden text-[11px] text-faint sm:block">{monitorLabel} account monitor</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              role="switch"
              aria-checked={autoRefresh}
              aria-label={autoRefresh ? "Pause automatic refresh" : "Resume automatic refresh"}
              title={
                autoRefresh
                  ? "Automatic checks are on (every minute; upstream readings may be cached) — click to pause"
                  : "Automatic checks are paused — click to resume"
              }
              className={`inline-flex h-11 w-11 items-center justify-center gap-2 rounded-xl border text-xs font-medium transition-all xs:w-auto xs:rounded-full xs:px-3 ${
                autoRefresh ? "text-coral-bright" : "border-border text-faint hover:text-muted"
              }`}
              style={
                autoRefresh
                  ? { borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)" }
                  : undefined
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${autoRefresh ? "bg-coral" : "bg-faint"}`}
                style={autoRefresh ? { boxShadow: "0 0 6px var(--accent)" } : undefined}
              />
              <span className="hidden xs:inline">{autoRefresh ? "Auto" : "Paused"}</span>
            </button>
            <button
              type="button"
              onClick={() => void refreshAll(true)}
              disabled={refreshing || accounts.length === 0}
              aria-label="Refresh all accounts"
              title="Refresh all accounts"
              className="inline-flex h-11 w-11 items-center justify-center gap-2 rounded-xl border border-border text-sm font-medium text-muted transition-all enabled:hover:border-border-light enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:opacity-40 sm:w-auto sm:px-3.5"
            >
              <RefreshIcon className={`h-4 w-4 ${refreshing ? "animate-spin-slow" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button
              type="button"
              onClick={() => setNotifyOpen(true)}
              aria-label="Notifications"
              title="Notifications"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border text-muted transition-all hover:border-border-light hover:bg-surface-hover hover:text-ivory"
            >
              <BellIcon className="h-4 w-4" />
            </button>
            <button
              ref={addAccountButtonRef}
              type="button"
              onClick={handleAddClick}
              aria-label="Add account"
              className="inline-flex h-11 w-11 items-center justify-center gap-1.5 rounded-xl bg-coral text-sm font-medium text-white shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)] transition-all enabled:hover:shadow-[0_10px_28px_-12px_rgba(0,0,0,0.7)] disabled:opacity-50 sm:w-auto sm:px-3.5"
            >
              <PlusIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Add account</span>
            </button>
            {showSignOut && <SignOutButton onError={setActionError} />}
          </div>
        </div>
      </header>

      <main
        id="dashboard-main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-16 sm:px-6 sm:pt-8"
      >
        {actionError && (
          <div role="alert" className="animate-fade-in mb-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ff9c95]">
            {actionError}
          </div>
        )}
        {vaultRecoveryNotice && (
          <div role="status" className="animate-fade-in mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-ivory">
            <span>{vaultRecoveryNotice}</span>
            <button
              type="button"
              onClick={() => setVaultRecoveryNotice(null)}
              className="min-h-11 rounded-lg border border-current/30 px-3 text-xs font-medium hover:bg-white/5"
            >
              Dismiss
            </button>
          </div>
        )}
        {saveState !== "idle" && (
          <div
            role={saveState === "error" ? "alert" : "status"}
            className={`animate-fade-in mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
              saveState === "error" ? "border-danger/30 bg-danger/10 text-[#ff9c95]" : "border-border bg-surface text-muted"
            }`}
          >
            <span>{saveState === "saving" ? "Saving account changes…" : saveError}</span>
            {saveState === "error" && (
              <button type="button" onClick={retrySave} className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5">
                Retry save
              </button>
            )}
          </div>
        )}
        {preferenceError && (
          <div role="alert" className="animate-fade-in mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ff9c95]">
            <span>{preferenceError}</span>
            <button type="button" onClick={retryPreference} className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5">
              Retry preference
            </button>
          </div>
        )}
        {syncError && vaultState === "ready" && (
          <div role="alert" className="animate-fade-in mb-4 flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-[#ff9c95]">
            <span>Saved-account sync failed: {syncError}</span>
            <button type="button" onClick={() => void reloadVault().catch(() => {})} className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5">
              Retry sync
            </button>
          </div>
        )}
        {vaultState === "loading" ? (
          <div className="mx-auto mt-14 max-w-md space-y-4" aria-label="Loading saved accounts" role="status">
            <div className="skeleton mx-auto h-12 w-12 rounded-full" />
            <div className="skeleton mx-auto h-8 w-3/4 rounded-lg" />
            <div className="skeleton mx-auto h-4 w-full rounded" />
          </div>
        ) : vaultState === "error" ? (
          <div className="animate-rise mx-auto mt-14 max-w-md rounded-2xl border border-danger/30 bg-danger/10 p-6 text-center">
            <StarburstIcon className="mx-auto h-10 w-10 text-[#ff9c95]" />
            <h2 className="font-display mt-5 text-2xl text-ivory">Saved accounts couldn't be loaded</h2>
            <p role="alert" className="mt-3 text-sm leading-relaxed text-muted">
              {vaultError ?? "Your saved data was left untouched. Check storage and try again."}
            </p>
            {vaultUnreadable && (
              <p className="mt-3 text-xs leading-relaxed text-[#f0c47d]">
                Reloading cannot fix a missing encryption key. Restore the previous secret, or preserve this unreadable file as a backup and start with an empty vault.
              </p>
            )}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => void loadVault()}
                disabled={vaultRecoveryBusy}
                className="min-h-11 rounded-xl bg-coral px-5 py-2.5 text-sm font-medium text-white enabled:hover:bg-coral-pressed disabled:opacity-50"
              >
                Retry after restoring key
              </button>
              {vaultUnreadable && (
                <button
                  type="button"
                  onClick={() => {
                    dispatchVaultUi({ type: "recovery_confirmation_opened" });
                  }}
                  disabled={vaultRecoveryBusy}
                  className="min-h-11 rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-ivory enabled:hover:bg-surface-hover disabled:opacity-50"
                >
                  Start fresh safely
                </button>
              )}
            </div>
            {vaultRecoveryConfirm && (
              <div role="alert" className="mt-4 rounded-xl border border-[#e3b56e]/35 bg-bg/60 p-4 text-left">
                <p className="text-sm font-medium text-ivory">Archive the unreadable vault and start fresh?</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  The encrypted file will be renamed and kept as a backup. No credential can be recovered without its old key, and you will need to reconnect each account once.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => dispatchVaultUi({ type: "recovery_confirmation_closed" })}
                    disabled={vaultRecoveryBusy}
                    className="min-h-11 rounded-lg border border-border px-3 text-xs font-medium text-ivory enabled:hover:bg-surface-hover disabled:opacity-50"
                  >
                    Keep current vault
                  </button>
                  <button
                    type="button"
                    onClick={() => void recoverUnreadableVault()}
                    disabled={vaultRecoveryBusy}
                    aria-busy={vaultRecoveryBusy}
                    className="min-h-11 rounded-lg bg-danger/20 px-3 text-xs font-semibold text-[#ff9c95] enabled:hover:bg-danger/30 disabled:opacity-50"
                  >
                    {vaultRecoveryBusy ? "Archiving…" : "Archive and start fresh"}
                  </button>
                </div>
              </div>
            )}
            {vaultRecoveryError && (
              <p role="alert" className="mt-3 text-xs leading-relaxed text-[#ff9c95]">
                {vaultRecoveryError}
              </p>
            )}
          </div>
        ) : accounts.length === 0 ? (
          <div className="animate-rise mx-auto mt-12 max-w-md text-center sm:mt-16">
            <StarburstIcon className="mx-auto h-12 w-12 text-coral" />
            <h2 className="font-display mt-6 text-3xl text-ivory">Every account. One dashboard.</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              Connect your Claude and ChatGPT/Codex accounts to check usage limits automatically — no more logging in
              and out to see where you stand.
            </p>
            <button
              type="button"
              onClick={handleAddClick}
              className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-coral px-5 py-2.5 text-sm font-medium text-white transition-colors enabled:hover:bg-coral-pressed"
            >
              <PlusIcon className="h-4 w-4" />
              Connect your first account
            </button>
          </div>
        ) : (
          <>
            {connectedProviders.length > 1 && (
              <div role="group" aria-label="Filter accounts by provider" className="animate-rise mb-4 inline-flex rounded-lg border border-border p-0.5">
                {(["all", ...connectedProviders] as const).map((id) => {
                  const selected = activeFilter === id;
                  const meta = id === "all" ? null : providerMeta(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setProviderFilter(id)}
                      aria-pressed={selected}
                      className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${
                        selected ? "bg-surface-hover text-ivory" : "text-muted hover:text-ivory"
                      }`}
                    >
                      {meta && <meta.Icon className="h-3.5 w-3.5" />}
                      {meta ? meta.label : "All"}
                    </button>
                  );
                })}
              </div>
            )}
            {accounts.length >= 2 && (
              <div className="animate-rise mb-6 grid grid-cols-2 gap-2 xs:grid-cols-3 sm:gap-3">
                <div className="col-span-2 rounded-xl border border-border bg-surface px-3 py-3 xs:col-span-1 sm:px-4">
                  <p className="text-[11px] uppercase tracking-wide text-faint">Accounts</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ivory">{visibleAccounts.length}</p>
                </div>
                <div className="min-w-0 rounded-xl border border-border bg-surface px-3 py-3 sm:px-4">
                  <p className="text-[11px] uppercase tracking-wide text-faint">Peak session</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ivory">
                    {stats.peakSession ? `${Math.round(stats.peakSession.percent)}%` : "—"}
                  </p>
                  {stats.peakSession && (
                    <p title={stats.peakSession.displayName} className="truncate text-[11px] text-faint">
                      {stats.peakSession.displayName}
                    </p>
                  )}
                </div>
                <div className="min-w-0 rounded-xl border border-border bg-surface px-3 py-3 sm:px-4">
                  <p className="text-[11px] uppercase tracking-wide text-faint">Peak weekly</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ivory">
                    {stats.peakWeekly ? `${Math.round(stats.peakWeekly.percent)}%` : "—"}
                  </p>
                  {stats.peakWeekly && (
                    <p title={stats.peakWeekly.displayName} className="truncate text-[11px] text-faint">
                      {stats.peakWeekly.displayName}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
              {visibleAccounts.map((account, i) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  snapshot={snapshots[account.id]}
                  now={now}
                  index={i}
                  onRefresh={() => void refreshAccount(account.id, true)}
                  onRemove={() => removeAccount(account.id)}
                  onReconnect={() => reconnect(account)}
                  onRename={(label) => renameAccount(account.id, label)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-1 px-6 py-6 text-center text-[11px] leading-relaxed text-faint">
          <p>Unofficial tool — not affiliated with Anthropic or OpenAI. Account tokens are stored encrypted.</p>
          {lastRefreshAll && (
            <p>
              {lastRefreshAll.updated === lastRefreshAll.total
                ? `Last refreshed ${formatClock(lastRefreshAll.at)}`
                : lastRefreshAll.updated > 0
                  ? `Last refresh ${formatClock(lastRefreshAll.at)} · ${lastRefreshAll.updated}/${lastRefreshAll.total} accounts updated`
                  : `Last refresh attempted ${formatClock(lastRefreshAll.at)} · no accounts updated`}
            </p>
          )}
        </div>
      </footer>

      <AddAccountModal
        open={modalOpen}
        onClose={closeModal}
        reconnectAccount={reconnectAccount}
        onServerConnected={reloadVault}
      />
      <NotificationsPanel open={notifyOpen} onClose={closeNotifications} />
    </div>
  );
}
