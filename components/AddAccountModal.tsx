"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DUMP_COMMANDS, parseCredentials } from "@/lib/credentials";
import { serverErrorText } from "@/lib/error-reference";
import { buildAuthorizeUrl, clearPkce, loadOrCreatePkce, parsePastedCode, type PkceBundle } from "@/lib/oauth";
import type { BrowserAccount } from "@/lib/types";
import type { ProviderId } from "@/lib/providers/types";
import { CheckIcon, CopyIcon, DesktopIcon, SpinnerIcon, TerminalIcon } from "./Icons";
import { ModalShell } from "./ModalShell";
import { Sub2ApiConnect } from "./Sub2ApiConnect";
import { PROVIDER_META, PROVIDER_ORDER, parseCodexCredential } from "./providers-ui";

interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  reconnectAccount?: BrowserAccount | null;
  // Local / pairing flow: the server added the account to the vault directly, so the dashboard should
  // re-pull the vault.
  onServerConnected: () => void | Promise<void>;
}

function errText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

type OS = "macOS" | "linux" | "windows";
type CredentialMethod = "private-login" | "existing-session";
const OS_LABELS: Record<OS, string> = { macOS: "macOS", linux: "Linux", windows: "Windows" };

// Which primary connect flow this deployment offers (feature-detected on open).
type Mode = "local" | "pair" | "paste";

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall through to the selection-based copy path below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is blocked in this browser. Select the command and copy it manually.");
}

// The accent-btn class follows the nearest [data-provider] scope (coral for Claude, mono for ChatGPT);
// its hover shade is handled in globals.css, so no per-state coral utilities are needed here.
const PRIMARY_BTN =
  "accent-btn inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50";
const PRIMARY_BUTTON = PRIMARY_BTN;
const PRIMARY_LINK = PRIMARY_BTN;
const REQUEST_TIMEOUT_MS = 30_000;

function timeoutError(action: string): Error {
  return new Error(`${action} timed out after 30 seconds. Check your connection and try again.`);
}

async function withDeadline<T>(promise: Promise<T>, action: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(timeoutError(action)), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function AddAccountModal({ open, onClose, reconnectAccount, onServerConnected }: AddAccountModalProps) {
  const [mode, setMode] = useState<Mode>("paste");
  const [showPaste, setShowPaste] = useState(true);
  // Which provider is being connected. Reconnect is locked to the account's own provider.
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [source, setSource] = useState<"direct" | "sub2api">("direct");

  // Paste flow.
  const [os, setOs] = useState<OS>("macOS");
  const [credentialMethod, setCredentialMethod] = useState<CredentialMethod>("private-login");
  const [pasted, setPasted] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [oauthBundle, setOauthBundle] = useState<PkceBundle | null>(null);
  const [oauthOpened, setOauthOpened] = useState(false);

  // Local flow.
  const [localWorking, setLocalWorking] = useState(false);
  const [localError, setLocalError] = useState<{ message: string; recommendation?: string } | null>(null);

  // Pairing flow.
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairCommand, setPairCommand] = useState("");
  const [pairState, setPairState] = useState<"waiting" | "processing" | "expired" | "error">("waiting");
  const [pairStarting, setPairStarting] = useState(false);
  const [pairCopied, setPairCopied] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairCopyError, setPairCopyError] = useState<string | null>(null);

  // Shared success (local or pair).
  const [connected, setConnected] = useState<{ email: string; plan?: string; label?: string } | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGeneration = useRef(0);
  const closedRef = useRef(false);
  const pairStartGeneration = useRef(0);
  const pairStartPromise = useRef<Promise<boolean> | null>(null);
  const pairStartController = useRef<AbortController | null>(null);
  const operationController = useRef<AbortController | null>(null);
  const operationRef = useRef<"oauth" | "manual" | "local" | "pair-start" | null>(null);
  const focusModeAfterSwitch = useRef(false);
  const pasteHeadingRef = useRef<HTMLParagraphElement>(null);
  const localActionRef = useRef<HTMLButtonElement>(null);
  const pairHeadingRef = useRef<HTMLParagraphElement>(null);

  const stopPolling = useCallback(() => {
    pollGeneration.current += 1;
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reloadAndClose = useCallback(async () => {
    setCompletionError(null);
    try {
      await withDeadline(Promise.resolve(onServerConnected()), "Dashboard sync");
      if (!closedRef.current) onClose();
    } catch (error) {
      if (!closedRef.current) {
        setCompletionError(
          error instanceof Error
            ? error.message
            : "The account connected, but the dashboard couldn't reload it. Try syncing again.",
        );
      }
    }
  }, [onClose, onServerConnected]);

  // Server-side connect succeeded → briefly show success, then reload the vault and close.
  const finishServerConnect = useCallback(
    (info: { email: string; plan?: string; label?: string }) => {
      stopPolling();
      setConnected(info);
      setCompletionError(null);
      if (finishRef.current) clearTimeout(finishRef.current);
      finishRef.current = setTimeout(() => {
        if (closedRef.current) return;
        void reloadAndClose();
      }, 1100);
    },
    [reloadAndClose, stopPolling],
  );

  const pollPairing = useCallback(
    (code: string) => {
      stopPolling();
      const generation = pollGeneration.current;
      let failures = 0;
      const schedule = (delay: number) => {
        if (closedRef.current || generation !== pollGeneration.current) return;
        pollRef.current = setTimeout(() => void tick(), delay);
      };
      const tick = async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch(`/api/connect/pair/status?code=${encodeURIComponent(code)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (closedRef.current || generation !== pollGeneration.current) return;
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          const data = (await res.json().catch(() => ({}))) as { status?: string; email?: string; error?: string };
          if (!res.ok) {
            failures += 1;
            if (failures >= 3) {
              stopPolling();
              setPairError(errText(data.error, "Couldn't reach the pairing service. Try again."));
              setPairState("error");
              return;
            }
            schedule(Math.min(7500, 1500 * 2 ** failures));
            return;
          }
          failures = 0;
          if (data.status === "done") {
            finishServerConnect({ email: data.email ?? "your account" });
          } else if (data.status === "processing") {
            setPairState("processing");
            schedule(1500);
          } else if (data.status === "failed") {
            stopPolling();
            setPairError(errText(data.error, "The account couldn't be saved. Get a new code and try again."));
            setPairState("error");
          } else if (data.status === "expired") {
            stopPolling();
            setPairState("expired");
          } else {
            setPairState("waiting");
            schedule(2500);
          }
        } catch {
          failures += 1;
          if (failures >= 3) {
            stopPolling();
            setPairError("Couldn't reach the pairing service. Check your connection and try again.");
            setPairState("error");
          } else {
            schedule(Math.min(7500, 1500 * 2 ** failures));
          }
        } finally {
          clearTimeout(timeout);
        }
      };
      schedule(2500);
    },
    [finishServerConnect, stopPolling],
  );

  const startPairing = useCallback((): Promise<boolean> => {
    // The start endpoint mints a new single-use code. Reuse one in-flight promise so double-clicks,
    // keyboard activation, and quick retries cannot create overlapping codes whose responses race.
    if (pairStartPromise.current) return pairStartPromise.current;
    if (operationRef.current) return Promise.resolve(false);

    const generation = ++pairStartGeneration.current;
    const controller = new AbortController();
    pairStartController.current = controller;
    operationRef.current = "pair-start";
    setPairStarting(true);
    setPairCode(null);
    setPairCommand("");
    setPairCopied(false);
    setPairCopyError(null);
    setPairError(null);
    setPairState("waiting");
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        const res = await fetch("/api/connect/pair/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedAccountId: reconnectAccount?.id }),
          signal: controller.signal,
        });
        if (closedRef.current || generation !== pairStartGeneration.current) return false;
        if (res.status === 401) {
          window.location.href = "/login";
          return false;
        }
        const data = (await res.json().catch(() => ({}))) as { code?: string; command?: string; error?: string };
        if (closedRef.current || generation !== pairStartGeneration.current) return false;
        if (!res.ok || !data.code || !data.command) {
          setPairError(errText(data.error, "Couldn't start pairing. Try again."));
          setPairState("error");
          return false;
        }
        setPairCode(data.code);
        setPairCommand(data.command);
        setPairState("waiting");
        setPairError(null);
        setConnected(null);
        pollPairing(data.code);
        return true;
      } catch (startError) {
        if (
          controller.signal.aborted ||
          closedRef.current ||
          generation !== pairStartGeneration.current ||
          (startError instanceof Error && startError.name === "AbortError")
        ) {
          if (!closedRef.current && generation === pairStartGeneration.current) {
            setPairError("Getting a pairing code timed out after 30 seconds. Check your connection and try again.");
            setPairState("error");
          }
          return false;
        }
        setPairError("Couldn't start pairing. Check your connection and try again.");
        setPairState("error");
        return false;
      } finally {
        clearTimeout(timeout);
        if (pairStartPromise.current === attempt) pairStartPromise.current = null;
        if (pairStartController.current === controller) pairStartController.current = null;
        if (operationRef.current === "pair-start") operationRef.current = null;
        if (!closedRef.current && generation === pairStartGeneration.current) setPairStarting(false);
      }
    })();
    pairStartPromise.current = attempt;
    return attempt;
  }, [pollPairing, reconnectAccount?.id]);

  // A private full-scope OAuth login owned by this app is immediately visible on every deployment.
  // In the background we only detect which explicitly less-reliable shared-CLI alternative to offer;
  // no pairing code is minted until the user chooses it.
  useEffect(() => {
    if (!open) return;
    closedRef.current = false;
    pairStartGeneration.current += 1;
    pairStartController.current?.abort();
    pairStartController.current = null;
    pairStartPromise.current = null;
    operationController.current?.abort();
    operationController.current = null;
    operationRef.current = null;
    setMode("paste");
    setShowPaste(true);
    setProvider(reconnectAccount?.provider ?? "anthropic");
    setSource(reconnectAccount?.source === "sub2api" ? "sub2api" : "direct");
    setPasted("");
    setCredentialMethod("private-login");
    setError(null);
    setWorking(false);
    setCopied(false);
    setCopyError(null);
    setOauthBundle(null);
    setOauthOpened(false);
    setLocalWorking(false);
    setLocalError(null);
    setPairCode(null);
    setPairCommand("");
    setPairState("waiting");
    setPairStarting(false);
    setPairCopied(false);
    setPairError(null);
    setPairCopyError(null);
    setConnected(null);
    setCompletionError(null);

    let cancelled = false;
    void loadOrCreatePkce().then(
      (bundle) => {
        if (!cancelled) setOauthBundle(bundle);
      },
      () => {
        if (!cancelled) setError("Couldn't prepare a secure Claude sign-in. Close this dialog and try again.");
      },
    );
    (async () => {
      // Self-hosted local quick-connect is available only on the machine running the app. Otherwise
      // offer device pairing as the legacy alternative; availability is checked only if selected.
      try {
        const res = await fetch("/api/connect/local", { cache: "no-store" });
        if (cancelled) return;
        if (res.ok) {
          setMode("local");
          return;
        }
      } catch {
        /* fall through */
      }
      setMode("pair");
    })();

    return () => {
      cancelled = true;
    };
    // Runs only on open transitions; the convenience probe must not hide the durable setup flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Stop polling + mark closed whenever the modal is not open / unmounts.
  useEffect(() => {
    if (!open) {
      closedRef.current = true;
      pairStartGeneration.current += 1;
      pairStartController.current?.abort();
      pairStartController.current = null;
      pairStartPromise.current = null;
      operationController.current?.abort();
      operationController.current = null;
      operationRef.current = null;
      stopPolling();
      if (finishRef.current) {
        clearTimeout(finishRef.current);
        finishRef.current = null;
      }
    }
    return () => {
      pairStartGeneration.current += 1;
      pairStartController.current?.abort();
      pairStartController.current = null;
      pairStartPromise.current = null;
      operationController.current?.abort();
      operationController.current = null;
      operationRef.current = null;
      stopPolling();
      if (finishRef.current) {
        clearTimeout(finishRef.current);
        finishRef.current = null;
      }
    };
  }, [open, stopPolling]);

  useEffect(() => {
    if (!open || !focusModeAfterSwitch.current) return;
    focusModeAfterSwitch.current = false;
    const frame = requestAnimationFrame(() => {
      const target = showPaste
        ? pasteHeadingRef.current
        : mode === "local"
          ? localActionRef.current
          : pairHeadingRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, open, showPaste]);

  const connectLocal = useCallback(async () => {
    if (localWorking || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "local";
    setLocalWorking(true);
    setLocalError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("/api/connect/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        email?: string;
        plan?: string;
        label?: string;
        error?: string;
        recommendation?: string;
      };
      if (!res.ok) {
        setLocalError({
          message: errText(data.error, "Couldn't connect from this machine."),
          recommendation: typeof data.recommendation === "string" ? data.recommendation : undefined,
        });
        return;
      }
      finishServerConnect({ email: data.email ?? "your account", plan: data.plan, label: data.label });
    } catch (connectError) {
      if (!closedRef.current) {
        setLocalError({
          message:
            connectError instanceof Error && connectError.name === "AbortError"
              ? "Connection timed out after 30 seconds. Check that the app is running and try again."
              : "Network error — is the app still running?",
        });
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === "local") operationRef.current = null;
      if (!closedRef.current) setLocalWorking(false);
    }
  }, [localWorking, finishServerConnect, reconnectAccount?.id]);

  const connectPaste = useCallback(async () => {
    if (!pasted.trim() || working || operationRef.current) return;
    const oauthFlow = credentialMethod === "private-login";
    const operation = oauthFlow ? "oauth" : "manual";
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = operation;
    setWorking(true);
    setError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let res: Response;
      if (oauthFlow) {
        if (!oauthBundle) {
          throw new Error("Secure sign-in is still preparing. Wait a moment and try again.");
        }
        const authorization = parsePastedCode(pasted);
        if (!authorization.code || !authorization.state) {
          throw new Error("Paste the complete authorization code from Claude, including the #state suffix.");
        }
        if (authorization.state !== oauthBundle.state) {
          throw new Error("That code belongs to an older sign-in attempt. Open Claude sign-in again and paste its new code.");
        }
        res = await fetch("/api/connect/oauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: authorization.code,
            state: authorization.state,
            verifier: oauthBundle.verifier,
            expectedAccountId: reconnectAccount?.id,
          }),
          signal: controller.signal,
        });
      } else {
        const parsed = parseCredentials(pasted);
        if (!parsed) {
          throw new Error(
            'Couldn\'t read that. Paste the full Claude Code credential JSON containing "accessToken".',
          );
        }
        res = await fetch("/api/connect/manual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens: parsed.tokens, expectedAccountId: reconnectAccount?.id }),
          signal: controller.signal,
        });
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        errorId?: unknown;
        email?: string;
        plan?: string;
        label?: string;
      };
      if (res.status === 401 && data.error === "Not signed in") {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        throw new Error(
          serverErrorText(
            data.error,
            res.status === 401
              ? oauthFlow
                ? "Claude rejected that authorization code. Open a fresh sign-in and try again."
                : "That shared login may already have rotated. Copy a fresh credential and try again."
              : "Couldn't complete the Claude connection.",
            data.errorId,
          ),
        );
      }
      if (oauthFlow) clearPkce();
      finishServerConnect({
        email: data.email ?? reconnectAccount?.email ?? "your account",
        plan: data.plan,
        label: data.label,
      });
    } catch (err) {
      if (!closedRef.current) {
        setError(
          err instanceof Error && err.name === "AbortError"
            ? "Connection timed out after 30 seconds. Check your connection and try again."
            : err instanceof Error
              ? err.message
              : "Something went wrong — try again.",
        );
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === operation) operationRef.current = null;
      if (!closedRef.current) setWorking(false);
    }
  }, [credentialMethod, finishServerConnect, oauthBundle, pasted, reconnectAccount, working]);

  // OpenAI: one-click read of this machine's ~/.codex/auth.json.
  const connectOpenAILocal = useCallback(async () => {
    if (localWorking || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "local";
    setLocalWorking(true);
    setLocalError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("/api/connect/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        email?: string;
        plan?: string;
        label?: string;
        error?: string;
        recommendation?: string;
      };
      if (!res.ok) {
        setLocalError({
          message: errText(data.error, "Couldn't read the Codex login on this machine."),
          recommendation: typeof data.recommendation === "string" ? data.recommendation : undefined,
        });
        return;
      }
      finishServerConnect({ email: data.email ?? "your ChatGPT account", plan: data.plan, label: data.label });
    } catch (connectError) {
      if (!closedRef.current) {
        setLocalError({
          message:
            connectError instanceof Error && connectError.name === "AbortError"
              ? "Connection timed out after 30 seconds. Check that the app is running and try again."
              : "Network error — is the app still running?",
        });
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === "local") operationRef.current = null;
      if (!closedRef.current) setLocalWorking(false);
    }
  }, [localWorking, finishServerConnect, reconnectAccount?.id]);

  // OpenAI: paste ~/.codex/auth.json → parse client-side → verify + save server-side.
  const connectOpenAIPaste = useCallback(async () => {
    if (!pasted.trim() || working || operationRef.current) return;
    const controller = new AbortController();
    operationController.current = controller;
    operationRef.current = "manual";
    setWorking(true);
    setError(null);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const tokens = parseCodexCredential(pasted);
      if (!tokens) {
        throw new Error('Couldn\'t read that. Paste the full ~/.codex/auth.json (it contains "access_token").');
      }
      const res = await fetch("/api/connect/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", tokens, expectedAccountId: reconnectAccount?.id }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        errorId?: unknown;
        email?: string;
        plan?: string;
        label?: string;
      };
      if (res.status === 401 && data.error === "Not signed in") {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        throw new Error(
          serverErrorText(
            data.error,
            res.status === 401
              ? "That ChatGPT login expired or was rotated. Paste a fresh ~/.codex/auth.json."
              : "Couldn't connect the ChatGPT account.",
            data.errorId,
          ),
        );
      }
      finishServerConnect({
        email: data.email ?? reconnectAccount?.email ?? "your ChatGPT account",
        plan: data.plan,
        label: data.label,
      });
    } catch (err) {
      if (!closedRef.current) {
        setError(
          err instanceof Error && err.name === "AbortError"
            ? "Connection timed out after 30 seconds. Check your connection and try again."
            : err instanceof Error
              ? err.message
              : "Something went wrong — try again.",
        );
      }
    } finally {
      clearTimeout(timeout);
      if (operationController.current === controller) operationController.current = null;
      if (operationRef.current === "manual") operationRef.current = null;
      if (!closedRef.current) setWorking(false);
    }
  }, [finishServerConnect, pasted, reconnectAccount, working]);

  if (!open) return null;
  const requestBusy = working || localWorking || pairStarting || pairState === "processing";
  const command = DUMP_COMMANDS[os];
  const oauthUrl = oauthBundle ? buildAuthorizeUrl(oauthBundle) : null;

  const successCard = connected && (
    <div className="space-y-3">
      <div
        role="status"
        className="flex items-center gap-3 rounded-xl border px-4 py-3.5"
        style={{
          borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
          background: "var(--accent-soft)",
        }}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: "var(--accent-soft)", color: "var(--accent-bright)" }}
        >
          <CheckIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ivory">Connected {connected.label || connected.email}</p>
          <p className="truncate text-xs text-muted">
            {connected.email}
            {connected.plan ? ` · ${connected.plan}` : ""}
          </p>
        </div>
      </div>
      {!completionError && (
        <p role="status" className="inline-flex items-center gap-2 text-xs text-muted" aria-live="polite">
          <SpinnerIcon className="h-4 w-4 animate-spin-slow text-[var(--accent-bright)]" />
          Credential saved securely. Syncing the dashboard…
        </p>
      )}
      {completionError && (
        <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-[#ff9c95]">
          <p>{completionError}</p>
          <button
            type="button"
            onClick={() => void reloadAndClose()}
            className="mt-2 min-h-11 rounded-lg border border-current/30 px-3 py-1.5 font-medium hover:bg-white/5"
          >
            Retry dashboard sync
          </button>
        </div>
      )}
    </div>
  );

  // The private app-owned OAuth flow is primary. Importing the CLI's current rotating credential is
  // retained only as an explicit legacy option for environments where browser sign-in is impossible.
  const pasteBlock = (
    <div className="space-y-5">
      <div className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-xs font-semibold text-coral-bright">
          1
        </span>
        <div className="min-w-0 flex-1">
          <p ref={pasteHeadingRef} tabIndex={-1} className="text-sm text-ivory outline-none">
            {credentialMethod === "private-login" ? "Authorize a private login for this dashboard" : "Copy your current Claude Code session"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {credentialMethod === "private-login"
              ? "Sign in once with Claude. This app receives its own renewable session, stores it encrypted, and refreshes it without touching the login used by Claude Code."
              : "This quick method copies Claude Code's rotating login. The CLI and dashboard can invalidate one another when either renews it, so the private app login is more reliable."}
          </p>
          {credentialMethod === "private-login" && (
            <>
              <p className="mt-2 inline-flex rounded-full border border-coral/35 bg-coral/10 px-2.5 py-1 text-[11px] font-medium text-coral-bright">
                Recommended · connect once · renews automatically
              </p>
              <a
                href={oauthUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!oauthUrl || requestBusy}
                onClick={(event) => {
                  if (!oauthUrl || requestBusy) {
                    event.preventDefault();
                    return;
                  }
                  setPasted("");
                  setError(null);
                  setOauthOpened(true);
                }}
                className={`mt-3 ${PRIMARY_LINK} ${!oauthUrl || requestBusy ? "pointer-events-none opacity-50" : ""}`}
              >
                {oauthUrl ? "Open secure Claude sign-in" : "Preparing secure sign-in…"}
              </a>
              <p className="mt-2 text-[11px] leading-relaxed text-faint">
                Claude opens in a new tab and gives you a one-time authorization code. A <code>claude setup-token</code>{" "}
                token cannot be used here because Anthropic limits it to inference and blocks usage checks.
              </p>
              {oauthOpened && (
                <p role="status" className="mt-2 text-[11px] leading-relaxed text-muted">
                  Sign-in opened. Approve access, then copy the complete code shown by Claude.
                </p>
              )}
            </>
          )}
          {credentialMethod === "existing-session" && (
            <>
              <div className="mt-2.5 inline-flex rounded-lg border border-border p-0.5">
                {(Object.keys(OS_LABELS) as OS[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={requestBusy}
                    onClick={() => {
                      setOs(key);
                      setCopied(false);
                      setCopyError(null);
                    }}
                    aria-pressed={os === key}
                    className={`min-h-11 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      os === key ? "bg-surface-hover text-ivory" : "text-faint enabled:hover:text-muted"
                    }`}
                  >
                    {OS_LABELS[key]}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-stretch gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-secondary">
                  {command}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    setCopyError(null);
                    void copyText(command).then(
                      () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      },
                      (copyFailure) =>
                        setCopyError(copyFailure instanceof Error ? copyFailure.message : "Couldn't copy the command."),
                    );
                  }}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-ivory"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {os === "macOS" && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                  macOS will ask permission to read the keychain — click Allow.
                </p>
              )}
              {copyError && (
                <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
                  {copyError}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-xs font-semibold text-coral-bright">
          2
        </span>
        <div className="min-w-0 flex-1">
          <label htmlFor="claude-credentials" className="text-sm text-ivory">
            {credentialMethod === "private-login" ? "Paste the authorization code" : "Paste the credential JSON"}
          </label>
          <textarea
            id="claude-credentials"
            aria-label={credentialMethod === "private-login" ? "Claude authorization code" : "Claude Code credentials"}
            value={pasted}
            disabled={requestBusy}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) connectPaste();
            }}
            placeholder={
              credentialMethod === "private-login"
                ? "authorization-code#state"
                : '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-…","refreshToken":"…"}}'
            }
            spellCheck={false}
            autoComplete="off"
            rows={3}
            className="mt-2 w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-ivory placeholder:text-faint focus:border-coral/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={connectPaste}
            disabled={!pasted.trim() || requestBusy}
            className={`mt-2 ${PRIMARY_BUTTON}`}
          >
            {working ? "Connecting…" : credentialMethod === "private-login" ? "Finish secure connection" : "Connect shared session"}
          </button>
          <button
            type="button"
            disabled={requestBusy}
            onClick={() => {
              setCredentialMethod((current) =>
                current === "private-login" ? "existing-session" : "private-login",
              );
              setPasted("");
              setError(null);
              setCopied(false);
              setCopyError(null);
              setOauthOpened(false);
            }}
            className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-muted underline decoration-border underline-offset-4 transition-colors enabled:hover:text-ivory"
          >
            {credentialMethod === "private-login"
              ? "Use my existing Claude Code login instead"
              : "Use a private app login (recommended)"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-[#ff9c95]">
          {error}
        </p>
      )}
    </div>
  );

  // Legacy convenience flows always provide an obvious path back to the isolated app-owned login.
  const pasteFallback = (
    <div className="mt-5 border-t border-border/60 pt-4">
      {showPaste ? (
        pasteBlock
      ) : (
        <button
          type="button"
          onClick={() => {
            stopPolling();
            pairStartGeneration.current += 1;
            pairStartController.current?.abort();
            pairStartController.current = null;
            pairStartPromise.current = null;
            setPairCode(null);
            setPairCommand("");
            setPairState("waiting");
            setCredentialMethod("private-login");
            setOauthOpened(false);
            setPasted("");
            setError(null);
            focusModeAfterSwitch.current = true;
            setShowPaste(true);
          }}
          disabled={requestBusy}
          className="inline-flex min-h-11 items-center text-xs font-medium text-muted underline decoration-border underline-offset-4 transition-colors enabled:hover:text-ivory disabled:cursor-not-allowed disabled:opacity-45"
        >
          Back to the private app login (recommended)
        </button>
      )}
    </div>
  );

  const quickAlternative = mode !== "paste" && showPaste && !connected && (
    <div className="mt-5 rounded-xl border border-border/70 bg-surface/55 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-faint">Quick legacy alternative</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        {mode === "local"
          ? "Use the Claude Code login on this machine without copying it. This shares the CLI's rotating session and can disconnect when either process renews it."
          : "Pair the Claude Code login from another machine. This shares that CLI's rotating session and can disconnect when either process renews it."}
      </p>
      <button
        type="button"
        disabled={requestBusy}
        aria-busy={mode === "pair" && pairStarting}
        onClick={() => {
          focusModeAfterSwitch.current = true;
          setShowPaste(false);
          if (mode === "pair") void startPairing();
        }}
        className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-ivory transition-colors enabled:hover:bg-surface-hover disabled:opacity-50"
      >
        {mode === "pair" && pairStarting && <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />}
        {mode === "local"
          ? "Use this machine's current login"
          : pairStarting
            ? "Getting a pairing code…"
            : "Use the device pairing helper"}
      </button>
    </div>
  );

  const providerPicker = !reconnectAccount && !connected && (
    <div className="mt-5 inline-flex rounded-lg border border-border p-0.5">
      {PROVIDER_ORDER.map((pid) => {
        const meta = PROVIDER_META[pid];
        const Icon = meta.Icon;
        const active = source === "direct" && provider === pid;
        return (
          <button
            key={pid}
            type="button"
            disabled={requestBusy}
            aria-pressed={active}
            onClick={() => {
              stopPolling();
              setSource("direct");
              setProvider(pid);
              setError(null);
              setLocalError(null);
              setPasted("");
            }}
            className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
              active ? "bg-surface-hover text-ivory" : "text-faint enabled:hover:text-muted"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {meta.label}
          </button>
        );
      })}
      <button type="button" disabled={requestBusy} aria-pressed={source === "sub2api"}
        onClick={() => { stopPolling(); setSource("sub2api"); setError(null); }}
        className={`inline-flex min-h-11 items-center rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${source === "sub2api" ? "bg-surface-hover text-ivory" : "text-faint enabled:hover:text-muted"}`}>
        sub2api
      </button>
    </div>
  );

  const openaiBlock = (
    <div className="mt-5">
      {connected ? (
        successCard
      ) : (
        <div className="space-y-4">
          {mode === "local" && (
            <div className="rounded-xl border border-border bg-surface p-5">
              <div className="flex items-start gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                  style={{ background: "var(--accent-soft)", color: "var(--accent-bright)" }}
                >
                  <DesktopIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ivory">Read the Codex login on this computer</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Uses the ChatGPT login the Codex CLI already stored in <code>~/.codex/auth.json</code>. It is stored
                    encrypted in your vault and never displayed or sent anywhere else.
                  </p>
                  <button
                    ref={localActionRef}
                    type="button"
                    onClick={connectOpenAILocal}
                    disabled={requestBusy}
                    className={`mt-3 ${PRIMARY_BUTTON}`}
                  >
                    {localWorking && <SpinnerIcon className="h-4 w-4 animate-spin-slow" />}
                    {localWorking ? "Reading…" : "Read ChatGPT login from this machine"}
                  </button>
                  {localError && (
                    <div role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
                      <p>{localError.message}</p>
                      {localError.recommendation && <p className="mt-1 text-faint">{localError.recommendation}</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className={mode === "local" ? "border-t border-border/60 pt-4" : ""}>
            <p className="text-sm text-ivory">
              {mode === "local" ? "Or paste your ~/.codex/auth.json" : "Paste your ~/.codex/auth.json"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Run <code className="rounded bg-bg px-1 py-0.5 font-mono">cat ~/.codex/auth.json</code> and paste the whole
              output. The tokens are stored encrypted and never shown.
            </p>
            <textarea
              value={pasted}
              onChange={(event) => {
                setPasted(event.target.value);
                setError(null);
              }}
              spellCheck={false}
              rows={4}
              placeholder={'{ "tokens": { "access_token": "…", "refresh_token": "…" } }'}
              className="mt-2 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-secondary outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={connectOpenAIPaste}
              disabled={!pasted.trim() || working}
              className={`mt-3 ${PRIMARY_BUTTON}`}
            >
              {working && <SpinnerIcon className="h-4 w-4 animate-spin-slow" />}
              {working ? "Connecting…" : "Connect ChatGPT account"}
            </button>
            {error && (
              <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <ModalShell
      open={open}
      title={reconnectAccount ? `Reconnect ${reconnectAccount.label || reconnectAccount.email}` : "Connect an account"}
      description={
        reconnectAccount?.source === "sub2api" ? "Reconnect the same sub2api instance and account with its current admin key." : reconnectAccount ? "Authorize this same account so its expired session can be replaced without changing its dashboard identity." : undefined
      }
      onClose={onClose}
      dismissible={!requestBusy && (!connected || Boolean(completionError))}
    >
      <div className="contents" data-provider={provider}>
      {providerPicker}
      {source === "sub2api" ? (
        connected ? <div className="mt-5">{successCard}</div> : <Sub2ApiConnect
          expectedAccountId={reconnectAccount?.id} onBusyChange={setWorking} onConnected={finishServerConnect} />
      ) : provider === "openai" ? (
        openaiBlock
      ) : (
      <div className="mt-5">
          {(mode === "paste" || showPaste) && !connected && pasteBlock}
          {quickAlternative}

          {mode === "local" && (connected || !showPaste) && (
            <div>
              {connected ? (
                successCard
              ) : (
                <>
                  <div className="rounded-xl border border-border bg-surface p-5">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-coral/15 text-coral-bright">
                        <DesktopIcon className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ivory">Connect from this machine</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted">
                          We&apos;ll read the Claude Code login already on this computer. This is quick, but it shares a
                          rotating session with the CLI and is less reliable than the private app login.
                        </p>
                      </div>
                    </div>
                    <button
                      ref={localActionRef}
                      type="button"
                      onClick={connectLocal}
                      disabled={requestBusy}
                      className={`mt-4 ${PRIMARY_BUTTON}`}
                    >
                      {localWorking ? (
                        <>
                          <SpinnerIcon className="h-4 w-4 animate-spin-slow" />
                          Connecting…
                        </>
                      ) : (
                        <>
                          <DesktopIcon className="h-4 w-4" />
                          Connect from this machine
                        </>
                      )}
                    </button>
                  </div>
                  {localError && (
                    <div role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs leading-relaxed text-[#ff9c95]">
                      <p>{localError.message}</p>
                      {localError.recommendation && <p className="mt-1 text-muted">{localError.recommendation}</p>}
                    </div>
                  )}
                  {pasteFallback}
                </>
              )}
            </div>
          )}

          {mode === "pair" && (connected || !showPaste) && (
            <div>
              {connected ? (
                successCard
              ) : (
                <>
                  <div className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-coral/15 text-coral-bright">
                      <TerminalIcon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p ref={pairHeadingRef} tabIndex={-1} className="text-sm text-ivory outline-none">
                        Run one command where this account is signed in
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        On the computer where you use Claude Code, paste this into a terminal. It reads that
                        machine&apos;s current rotating login and connects it here as a less-reliable quick option.
                      </p>
                      {pairStarting && !pairCommand && (
                        <div role="status" className="mt-3 inline-flex items-center gap-2 text-xs text-muted">
                          <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />
                          Getting a single-use pairing code…
                        </div>
                      )}
                      {pairCommand && <div className="mt-2.5 flex items-stretch gap-2">
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-secondary">
                          {pairCommand}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            setPairCopyError(null);
                            void copyText(pairCommand).then(
                              () => {
                                setPairCopied(true);
                                setTimeout(() => setPairCopied(false), 2000);
                              },
                              (copyFailure) =>
                                setPairCopyError(copyFailure instanceof Error ? copyFailure.message : "Couldn't copy the command."),
                            );
                          }}
                          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-ivory"
                        >
                          <CopyIcon className="h-3.5 w-3.5" />
                          {pairCopied ? "Copied" : "Copy"}
                        </button>
                      </div>}
                      {pairCopyError && (
                        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-[#ff9c95]">
                          {pairCopyError}
                        </p>
                      )}

                      {pairCommand && pairState === "waiting" && !pairStarting && (
                        <div className="mt-3 inline-flex items-center gap-2 text-xs text-muted">
                          <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />
                          Waiting for you to run it…
                        </div>
                      )}
                      {pairState === "processing" && (
                        <div className="mt-3 inline-flex items-center gap-2 text-xs text-muted" role="status">
                          <SpinnerIcon className="h-4 w-4 animate-spin-slow text-coral" />
                          Account verified — saving it securely…
                        </div>
                      )}
                      {pairState === "expired" && (
                        <div className="mt-3 flex items-center gap-3">
                          <span className="text-xs text-[#e3b56e]">That code expired.</span>
                          <button
                            type="button"
                            onClick={() => void startPairing()}
                            disabled={requestBusy}
                            aria-busy={pairStarting}
                            className="min-h-11 rounded-lg border border-border px-3 py-1 text-xs font-medium text-ivory transition-colors enabled:hover:bg-surface-hover"
                          >
                            {pairStarting ? "Getting code…" : "Get a new code"}
                          </button>
                        </div>
                      )}
                      {pairState === "error" && (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <p role="alert" className="text-xs text-[#ff9c95]">
                            {pairError ?? "Couldn't reach the pairing service."}
                          </p>
                          <button
                            type="button"
                            onClick={() => void startPairing()}
                            disabled={requestBusy}
                            aria-busy={pairStarting}
                            className="min-h-11 rounded-lg border border-border px-3 py-1 text-xs font-medium text-ivory transition-colors enabled:hover:bg-surface-hover"
                          >
                            {pairStarting ? "Trying again…" : "Try again"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-border/70 bg-surface/60 p-3.5 text-[11px] leading-relaxed text-faint">
                    <p className="mb-1.5 font-medium text-muted">What happens &amp; why it&apos;s safe</p>
                    <ul className="space-y-1">
                      <li>It sends the same login token Claude Code already uses on that machine.</li>
                      <li>Sent over HTTPS and stored encrypted — only your dashboard can read it.</li>
                      <li>The helper is open source, so you can read exactly what it does before running it.</li>
                    </ul>
                  </div>
                  {pasteFallback}
                </>
              )}
            </div>
          )}

          <p className="mt-5 border-t border-border/60 pt-4 text-[11px] leading-relaxed text-faint">
              Credentials are encrypted in your private vault and used only for account checks with Anthropic. The
              recommended login has its own renewable session, so your normal Claude Code CLI cannot rotate it away.
              Quick connect imports the CLI&apos;s shared session and may need replacement if another process refreshes it first.
          </p>
      </div>
      )}
      </div>
    </ModalShell>
  );
}
