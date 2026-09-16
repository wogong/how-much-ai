"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AccountSnapshot, BrowserAccount } from "@/lib/types";
import { extractBars, formatClock, timeAgo } from "@/lib/format";
import { UsageBar } from "./UsageBar";
import { RefreshIcon, XIcon } from "./Icons";
import { providerMeta } from "./providers-ui";

const ICON_BTN =
  "flex h-11 w-11 items-center justify-center rounded-lg text-faint transition-colors enabled:hover:bg-surface-hover enabled:hover:text-ivory disabled:opacity-40";

export function accountDisplayName(
  account: Pick<BrowserAccount, "label" | "fullName" | "email">,
): string {
  return account.label || account.fullName || account.email;
}

interface AccountCardProps {
  account: BrowserAccount;
  snapshot: AccountSnapshot | undefined;
  now: number;
  index: number;
  onRefresh: () => void;
  onRemove: () => void;
  onReconnect: () => void;
  onRename: (label: string | undefined) => void;
}

export function AccountCard({
  account,
  snapshot,
  now,
  index,
  onRefresh,
  onRemove,
  onReconnect,
  onRename,
}: AccountCardProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const removeTitleId = useId();
  const removeDescriptionId = useId();

  useEffect(() => {
    if (!confirmRemove) return;
    const frame = requestAnimationFrame(() => cancelRemoveRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [confirmRemove]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const status = snapshot?.status ?? "idle";
  const loading = status === "loading";
  const bars = snapshot?.usage ? extractBars(snapshot.usage, now) : null;
  const hasBars = !!bars && bars.length > 0;
  // Stale = the server is showing its last-good reading because Anthropic rate-limited the upstream
  // poll (a cooldown), not a live fetch. We keep the bars but flag their age.
  const stale = (snapshot?.stale ?? false) && status !== "reauth";
  const displayName = accountDisplayName(account);
  const provider = providerMeta(account.provider);
  const credentialKind = account.credentialKind;
  const managedLogin = credentialKind === "managed";
  const externalSource = account.source === "sub2api";
  const setupToken = credentialKind === "long_lived" && !externalSource;
  const sharedCliLogin = credentialKind === "rotating";
  const tokenDaysRemaining = Math.ceil((account.credentialExpiresAt - now) / 86_400_000);
  const tokenExpiryWarning = setupToken && tokenDaysRemaining <= 30;
  const cooldownRemaining = Math.max(0, (snapshot?.cooldownUntil ?? 0) - now);
  const cooldownMinutes = Math.max(1, Math.ceil(cooldownRemaining / 60_000));
  const refreshDisabled = loading || status === "reauth" || cooldownRemaining > 0;
  const initial = displayName.charAt(0).toUpperCase() || "?";

  const restoreRenameFocus = () => {
    requestAnimationFrame(() => renameButtonRef.current?.focus({ preventScroll: true }));
  };

  const cancelRemove = () => {
    setConfirmRemove(false);
    requestAnimationFrame(() => removeButtonRef.current?.focus({ preventScroll: true }));
  };

  const commitRename = (restoreFocus = false) => {
    const trimmed = draft.trim();
    onRename(trimmed ? trimmed : undefined);
    setEditing(false);
    if (restoreFocus) restoreRenameFocus();
  };

  return (
    <article
      aria-labelledby={headingId}
      data-provider={account.provider ?? "anthropic"}
      className="animate-rise card-lift flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-5"
      style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}
      aria-busy={loading}
      onKeyDown={(event) => {
        if (!confirmRemove || event.key !== "Escape") return;
        event.preventDefault();
        cancelRemove();
      }}
    >
      <h2 id={headingId} className="sr-only">{displayName}</h2>
      <div className="flex min-w-0 flex-col gap-3 xs:flex-row xs:items-start xs:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-[15px] font-semibold"
            style={{
              background: "var(--avatar-bg)",
              color: "var(--avatar-fg)",
              borderColor: "var(--avatar-border)",
            }}
          >
            {initial}
          </div>
          <div className="min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                aria-label={`Nickname for ${account.email}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename(true);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                    restoreRenameFocus();
                  }
                }}
                placeholder={account.fullName || account.email}
                maxLength={40}
                className="min-h-11 w-full max-w-[12rem] rounded-md border border-border bg-bg px-2 py-1 text-[15px] font-medium text-ivory focus:border-[var(--accent)] focus:outline-none"
              />
            ) : (
              <button
                ref={renameButtonRef}
                type="button"
                onClick={() => {
                  setDraft(account.label ?? "");
                  setEditing(true);
                }}
                aria-label={`Rename ${displayName}`}
                title="Rename this account"
                className="flex min-h-11 min-w-11 max-w-full items-center truncate text-left text-[15px] font-medium text-ivory transition-colors hover:text-[var(--accent-bright)]"
              >
                {displayName}
              </button>
            )}
            <p className="truncate text-xs text-faint">{account.email}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end xs:self-auto">
          {(() => {
            const ProviderMark = provider.Icon;
            return (
              <span
                title={`${provider.label} · ${account.plan}`}
                className="mr-1 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted"
              >
                <span className="inline-flex" style={{ color: "var(--accent-bright)" }}>
                  <ProviderMark className="h-3 w-3 shrink-0" />
                </span>
                {account.plan}
              </span>
            );
          })()}
          <button
            type="button"
            className={ICON_BTN}
            title={
              status === "reauth"
                ? "Replace this account's token before refreshing"
                : cooldownRemaining > 0
                  ? `Retry available in ${cooldownMinutes} minute${cooldownMinutes === 1 ? "" : "s"}`
                  : "Refresh this account"
            }
            aria-label={
              status === "reauth"
                ? `Reconnect ${displayName} before refreshing`
                : cooldownRemaining > 0
                  ? `Refresh ${displayName} available in ${cooldownMinutes} minutes`
                  : `Refresh ${displayName}`
            }
            onClick={onRefresh}
            disabled={refreshDisabled}
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin-slow" : ""}`} />
          </button>
          <button
            ref={removeButtonRef}
            type="button"
            className={ICON_BTN}
            title="Remove this account from the dashboard"
            aria-label={`Remove ${displayName}`}
            onClick={() => setConfirmRemove(true)}
            disabled={confirmRemove}
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {confirmRemove && (
        <div
          role="group"
          aria-labelledby={removeTitleId}
          aria-describedby={removeDescriptionId}
          className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3"
        >
          <p id={removeTitleId} className="text-sm font-medium text-ivory">Remove {displayName}?</p>
          <p id={removeDescriptionId} className="mt-1 text-xs leading-relaxed text-muted">
            Its saved monitor credential will be deleted. You&apos;ll need to connect it again to restore monitoring.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={cancelRemoveRef}
              type="button"
              onClick={cancelRemove}
              className="min-h-11 rounded-lg border border-border px-3 text-xs font-medium text-ivory transition-colors hover:bg-surface-hover"
            >
              Keep account
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="min-h-11 rounded-lg bg-danger/20 px-3 text-xs font-semibold text-[#ff9c95] transition-colors hover:bg-danger/30"
            >
              Remove account
            </button>
          </div>
        </div>
      )}

      {sharedCliLogin && status !== "reauth" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e3b56e]/30 bg-[#e3b56e]/10 px-3 py-2 text-xs leading-relaxed text-[#f0c47d]">
          <span className="max-w-sm">
            {provider.supportsOAuth
              ? `This account shares ${provider.cliLabel}'s rotating login. A private app login renews independently.`
              : `This account shares ${provider.cliLabel}'s rotating login. Whichever side renews it can disconnect the other.`}
          </span>
          <button
            type="button"
            onClick={onReconnect}
            className="min-h-11 rounded-lg border border-current/30 px-3 font-semibold text-ivory transition-colors hover:bg-white/5"
          >
            {provider.supportsOAuth ? "Replace with private login" : `Re-import ${provider.cliLabel} login`}
          </button>
        </div>
      )}

      {tokenExpiryWarning && status !== "reauth" && (
        <div
          role="status"
          className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e3b56e]/30 bg-[#e3b56e]/10 px-3 py-2 text-xs leading-relaxed text-[#f0c47d]"
        >
          <span>
            {tokenDaysRemaining < 0
              ? "Estimated monitor-token renewal date has passed."
              : tokenDaysRemaining === 0
                ? "Estimated monitor-token renewal is due today."
                : `Estimated monitor-token renewal in ${tokenDaysRemaining} day${tokenDaysRemaining === 1 ? "" : "s"}.`}
          </span>
          <button
            type="button"
            onClick={onReconnect}
            className="min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-semibold text-ivory transition-colors hover:bg-white/5"
          >
            Replace with private login
          </button>
        </div>
      )}

      <div aria-live="polite" className={`mt-5 flex-1 space-y-4 transition-opacity duration-300 ${loading && hasBars ? "opacity-60" : ""}`}>
        {externalSource && (
          <div className="space-y-1 text-xs leading-relaxed text-muted">
            <p>sub2api quota sample: {snapshot?.usage?.snapshot?.sampledAt
              ? <time dateTime={snapshot.usage.snapshot.sampledAt}>{new Date(snapshot.usage.snapshot.sampledAt).toLocaleString()} ({timeAgo(Date.parse(snapshot.usage.snapshot.sampledAt), now)})</time>
              : "unknown"}</p>
            {snapshot?.usage?.snapshot?.refreshCompletedAt && (
              <p>Active refresh completed: {new Date(snapshot.usage.snapshot.refreshCompletedAt).toLocaleString()}. A successful request may still return cached data.</p>
            )}
            <p>Manual refresh asks sub2api to update usage; OpenAI may run an upstream probe.</p>
          </div>
        )}
        {status === "reauth" ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-bg-raised p-4">
            <p className="text-sm leading-relaxed text-muted">
              {externalSource ? "sub2api rejected its admin key. Reconnect with the current administrator key."
                : managedLogin
                ? "This private app login expired or was revoked. Sign in with Claude again to restore automatic renewal."
                : setupToken
                  ? "This legacy inference-only setup token expired or was revoked. Replace it to restore checks."
                  : provider.supportsOAuth
                    ? `This shared ${provider.cliLabel} session rotated somewhere else. Replace it with a private app login so normal CLI refreshes cannot disconnect the dashboard.`
                    : `This shared ${provider.cliLabel} session rotated somewhere else. Re-import the current login from that machine to restore checks.`}
            </p>
            <button
              type="button"
              onClick={onReconnect}
              className="accent-btn min-h-11 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors"
            >
              {externalSource ? "Reconnect sub2api" : managedLogin
                ? "Reconnect private login"
                : setupToken
                  ? "Replace with private login"
                  : provider.supportsOAuth
                    ? "Reconnect reliably"
                    : `Re-import ${provider.cliLabel} login`}
            </button>
          </div>
        ) : hasBars ? (
          <>
            {stale && (
              <div role="status" className="rounded-lg border border-[#e3b56e]/30 bg-[#e3b56e]/10 px-3 py-2 text-[11px] leading-relaxed text-[#e3b56e]">
                {externalSource ? snapshot?.error ?? "The quota sample is old or its time is unknown. Use Refresh to request an update from sub2api; its own cache or upstream errors may still leave the sample unchanged."
                  : `Rate-limited upstream — showing last update from ${snapshot?.fetchedAt ? timeAgo(snapshot.fetchedAt, now) : "earlier"}.`}
              </div>
            )}
            {bars.map((bar) => (
              <UsageBar
                key={bar.key}
                label={bar.label}
                percent={bar.percent}
                resetsAt={bar.resetsAt}
                severity={bar.severity}
                now={now}
              />
            ))}
          </>
        ) : status === "error" ? (
          <div role="status" className="flex flex-col items-start gap-3 rounded-xl border border-border bg-bg-raised p-4">
            <p className="text-sm text-muted">{snapshot?.error ?? "Couldn't load usage."}</p>
            <button
              type="button"
              onClick={onRefresh}
              disabled={cooldownRemaining > 0}
              className="min-h-11 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-ivory transition-colors enabled:hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cooldownRemaining > 0 ? `Retry in ${cooldownMinutes} min` : "Retry"}
            </button>
          </div>
        ) : status === "ready" ? (
          // Loaded successfully, but Anthropic reported no active limit buckets for this
          // account (e.g. a brand-new account, or an unrecognized response shape).
          <div className="rounded-xl border border-border bg-bg-raised p-4">
            <p className="text-sm text-muted">{externalSource ? "No current quota snapshot is available. Use Refresh to ask sub2api for usage." : "No usage limits reported yet for this account."}</p>
          </div>
        ) : (
          <div className="space-y-4" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <div className="skeleton h-3 w-2/5 rounded" />
                <div className="skeleton mt-2 h-2 w-full rounded-full" />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[11px] text-faint">
        <span>
          {status === "reauth" ? (
            <span className="text-[#e3b56e]">reconnect required</span>
          ) : status === "error" ? (
            <span className="text-[#e3b56e]">
              {hasBars ? "refresh failed — showing last data" : "refresh failed"}
            </span>
          ) : stale && hasBars ? (
            <span className="text-[#e3b56e]">{externalSource ? "saved snapshot — freshness unconfirmed" : "rate-limited — showing last update"}</span>
          ) : snapshot?.fetchedAt ? (
            `updated ${formatClock(snapshot.fetchedAt)}`
          ) : (
            "waiting for first refresh"
          )}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            title={
              externalSource ? "Usage is read through sub2api; manual refresh requests an upstream usage update" : managedLogin
                ? "Private app-owned Claude login; renews automatically without sharing Claude Code's session"
                : setupToken
                  ? `Legacy inference-only setup token; estimated renewal date ${new Date(account.credentialExpiresAt).toLocaleDateString()}`
                  : "Shared with Claude Code; a private app login is more reliable"
            }
            className={sharedCliLogin ? "text-[#e3b56e]" : "text-muted"}
          >
            {externalSource ? "sub2api · managed externally" : managedLogin ? "private app login · auto-renews" : setupToken ? "setup token · legacy" : "shared CLI login"}
          </span>
          {snapshot?.usage?.extra_usage?.is_enabled && <span>extra usage on</span>}
        </div>
      </div>
    </article>
  );
}
