"use client";

import { useEffect, useRef, useState } from "react";
import type { Sub2ApiAccountInfo } from "@/lib/sub2api";

export function Sub2ApiConnect({ expectedAccountId, onBusyChange, onConnected }: {
  expectedAccountId?: string;
  onBusyChange: (busy: boolean) => void;
  onConnected: (info: { email: string; plan?: string; label?: string }) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [accounts, setAccounts] = useState<Sub2ApiAccountInfo[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit(action: "list" | "connect" | "connect_all", nextPage = 1, accountId?: number) {
    if (controller.current) return;
    const attempt = new AbortController();
    controller.current = attempt;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch("/api/connect/sub2api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, baseUrl, adminKey, page: nextPage, accountId, expectedAccountId }),
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]),
      });
      const data = await response.json();
      if (attempt.signal.aborted) return;
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Couldn't connect sub2api.");
      if (action === "list") {
        setAccounts(data.accounts);
        setPage(nextPage);
        setHasMore(data.hasMore);
      } else {
        setAdminKey("");
        onConnected(data);
      }
    } catch (error) {
      if (!attempt.signal.aborted) setError(error instanceof Error ? error.message : "Couldn't reach sub2api.");
    } finally {
      controller.current = null;
      if (!attempt.signal.aborted) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  const inputClass = "mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-ivory focus:border-coral/60 focus:outline-none";
  return (
    <div className="mt-5 space-y-4">
      <p className="text-xs leading-relaxed text-muted">
        Read accounts already connected to sub2api. Automatic checks read saved snapshots. Manual refresh asks
        sub2api for updated usage and may trigger an OpenAI upstream probe. Upstream credentials stay managed
        by sub2api. Use HTTPS unless the connection stays on a trusted local network.
      </p>
      <label className="block text-sm text-ivory">
        sub2api URL
        <input type="url" value={baseUrl} disabled={busy} placeholder="https://sub2api.example.com"
          onChange={e => { setBaseUrl(e.target.value); setAccounts(null); }} className={inputClass} autoComplete="off" />
      </label>
      <label className="block text-sm text-ivory">
        Admin API Key
        <input type="password" value={adminKey} disabled={busy} autoComplete="off" spellCheck={false}
          onChange={e => { setAdminKey(e.target.value); setAccounts(null); }} className={inputClass} />
      </label>
      <p className="text-xs text-muted">Use the administrator key, not an inference API key. It is stored in the encrypted server vault.</p>
      <button type="button" disabled={busy || !baseUrl.trim() || !adminKey.trim()} onClick={() => void submit("list")}
        className="accent-btn min-h-11 w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
        {busy ? "Working…" : "Load accounts"}
      </button>
      {accounts && (
        <div className="space-y-2">
          {!expectedAccountId && (
            <button type="button" disabled={busy} onClick={() => void submit("connect_all")}
              className="accent-btn min-h-11 w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
              Connect all Claude &amp; ChatGPT accounts
            </button>
          )}
          <p className="text-xs text-muted">{expectedAccountId ? "Select the same account to reconnect." : "Connect all supported accounts across every page, or choose one below. Existing connections are updated without duplicates."}</p>
          {accounts.length === 0 && <p className="text-sm text-muted">No supported accounts on this page.</p>}
          {accounts.map(account => (
            <button key={account.accountId} type="button" disabled={busy} onClick={() => void submit("connect", page, account.accountId)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left text-sm text-ivory enabled:hover:bg-surface-hover disabled:opacity-50">
              <span className="min-w-0 break-words">{account.name}<span className="block text-xs text-muted">#{account.accountId} · {account.provider === "openai" ? "ChatGPT" : "Claude"} · {account.plan}</span></span>
              <span>{expectedAccountId ? "Reconnect" : "Connect"}</span>
            </button>
          ))}
          <div className="flex items-center justify-between text-xs text-muted">
            <button type="button" disabled={busy || page === 1} onClick={() => void submit("list", page - 1)} className="min-h-11 disabled:opacity-40">Previous</button>
            <span>Page {page}</span>
            <button type="button" disabled={busy || !hasMore} onClick={() => void submit("list", page + 1)} className="min-h-11 disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-[#ff9c95]">{error}</p>}
    </div>
  );
}
