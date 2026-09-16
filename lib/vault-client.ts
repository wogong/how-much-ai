import type { BrowserAccount, VaultMutation } from "./types";
import { safeServerErrorId, serverErrorText } from "./error-reference";

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The request timed out after 20 seconds. Try again.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Browser access to the encrypted server vault. Accounts are display-only DTOs; every write is a
// bounded semantic mutation keyed by account id and conditional on the opaque full-vault revision.
export interface VaultSnapshot {
  accounts: BrowserAccount[];
  revision: string;
}

export interface VaultRecoveryResult {
  archive: string;
  backupArchive?: string;
}

export class VaultConflictError extends Error {
  readonly latest: VaultSnapshot;

  constructor(message: string, latest: VaultSnapshot) {
    super(message);
    this.name = "VaultConflictError";
    this.latest = latest;
  }
}

export type VaultErrorCode = "VAULT_UNREADABLE";

export class VaultRequestError extends Error {
  readonly errorId: string | undefined;
  readonly errorCode: VaultErrorCode | undefined;

  constructor(message: string, errorId: unknown, errorCode: unknown) {
    const safeErrorId = safeServerErrorId(errorId);
    super(serverErrorText(message, message, safeErrorId));
    this.name = "VaultRequestError";
    this.errorId = safeErrorId;
    this.errorCode = errorCode === "VAULT_UNREADABLE" ? errorCode : undefined;
  }
}

function vaultRequestError(data: unknown, fallback: string): VaultRequestError {
  const candidate = data && typeof data === "object" && !Array.isArray(data)
    ? data as { error?: unknown; errorId?: unknown; errorCode?: unknown }
    : {};
  const message = typeof candidate.error === "string" && candidate.error.trim()
    ? candidate.error.trim()
    : fallback;
  return new VaultRequestError(message, candidate.errorId, candidate.errorCode);
}

function toLogin() {
  if (typeof window !== "undefined") window.location.href = "/login";
}

function isBrowserAccount(value: unknown): value is BrowserAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const account = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "email",
    "fullName",
    "label",
    "plan",
    "addedAt",
    "credentialKind",
    "provider",
    "source",
    "credentialExpiresAt",
  ]);
  if (!Object.keys(account).every((key) => allowed.has(key))) return false;
  return (
    typeof account.id === "string" &&
    typeof account.email === "string" &&
    (account.fullName === undefined || typeof account.fullName === "string") &&
    (account.label === undefined || typeof account.label === "string") &&
    typeof account.plan === "string" &&
    typeof account.addedAt === "number" &&
    Number.isFinite(account.addedAt) &&
    account.addedAt >= 0 &&
    (account.credentialKind === "long_lived" ||
      account.credentialKind === "rotating" ||
      account.credentialKind === "managed") &&
    (account.provider === undefined ||
      account.provider === "anthropic" ||
      account.provider === "openai") &&
    (account.source === undefined || account.source === "sub2api") &&
    typeof account.credentialExpiresAt === "number" &&
    Number.isFinite(account.credentialExpiresAt) &&
    account.credentialExpiresAt >= 0
  );
}

function snapshotFrom(value: unknown): VaultSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { accounts?: unknown; revision?: unknown };
  if (
    !Array.isArray(candidate.accounts) ||
    !candidate.accounts.every(isBrowserAccount) ||
    typeof candidate.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.revision)
  ) {
    return null;
  }
  return { accounts: candidate.accounts, revision: candidate.revision };
}

function safeMutation(mutation: VaultMutation): VaultMutation {
  if (mutation.op === "remove") return { op: "remove", accountId: mutation.accountId };
  if (mutation.op === "rename") {
    return { op: "rename", accountId: mutation.accountId, label: mutation.label };
  }
  return {
    op: "update_metadata",
    accountId: mutation.accountId,
    ...(mutation.email !== undefined ? { email: mutation.email } : {}),
    ...(mutation.fullName !== undefined ? { fullName: mutation.fullName } : {}),
    ...(mutation.plan !== undefined ? { plan: mutation.plan } : {}),
  };
}

export async function fetchVault(): Promise<VaultSnapshot> {
  const res = await fetchWithTimeout("/api/vault", { cache: "no-store" });
  if (res.status === 401) {
    toLogin();
    throw new Error("Your session expired. Redirecting to sign in…");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw vaultRequestError(data, "Couldn't load saved accounts");
  }
  const snapshot = snapshotFrom(data);
  if (!snapshot) throw new Error("Saved accounts returned an invalid synchronization revision. Reload the app.");
  return snapshot;
}

export async function saveVaultMutations(
  mutations: readonly VaultMutation[],
  revision: string,
): Promise<VaultSnapshot> {
  const res = await fetchWithTimeout("/api/vault", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mutations: mutations.map(safeMutation), revision }),
  });
  if (res.status === 401) {
    toLogin();
    throw new Error("Your session expired. Redirecting to sign in…");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) {
    const latest = snapshotFrom(data);
    if (latest) {
      throw new VaultConflictError(
        typeof data?.error === "string" ? data.error : "Saved accounts changed while saving.",
        latest,
      );
    }
  }
  if (!res.ok) {
    throw vaultRequestError(data, "Couldn't save account changes");
  }
  const snapshot = snapshotFrom(data);
  if (!snapshot) throw new Error("The vault saved, but its synchronization response was invalid. Reload the app.");
  return snapshot;
}

// Mutations are idempotent and touch only named display fields. After a 409 (including one caused by
// a server-side token rotation), replaying the same intent against the returned revision preserves
// every credential and unrelated concurrent edit without sending either token through the browser.
export async function persistVaultMutations(
  startingSnapshot: VaultSnapshot,
  mutations: readonly VaultMutation[],
  maxAttempts = 5,
): Promise<VaultSnapshot> {
  if (mutations.length === 0) return startingSnapshot;
  let latest = startingSnapshot;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await saveVaultMutations(mutations, latest.revision);
    } catch (error) {
      if (!(error instanceof VaultConflictError)) throw error;
      latest = error.latest;
    }
  }
  throw new Error("Saved accounts kept changing while this edit was being merged. Reload and try again.");
}

export async function logout(): Promise<void> {
  const res = await fetchWithTimeout("/api/auth/logout", { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data?.error === "string" ? data.error : "Couldn't sign out. Try again.");
  }
  toLogin();
}

function safeArchiveLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return undefined;
  // Recovery labels are displayed to the operator, never treated as paths. Accept historical label
  // shapes while rejecting separators, control characters, whitespace, and arbitrary reflected text.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : undefined;
}

export async function archiveUnreadableVault(): Promise<VaultRecoveryResult> {
  const res = await fetchWithTimeout("/api/vault/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "ARCHIVE_UNREADABLE_VAULT" }),
  });
  if (res.status === 401) {
    toLogin();
    throw new Error("Your session expired. Redirecting to sign in…");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw vaultRequestError(data, "Couldn't archive the unreadable vault.");
  }
  const archive = safeArchiveLabel(data?.archive);
  const backupArchive = data?.backupArchive === undefined ? undefined : safeArchiveLabel(data.backupArchive);
  if (!archive || (data?.backupArchive !== undefined && !backupArchive)) {
    throw new Error("The vault was archived, but the server returned an invalid recovery response. Reload the page.");
  }
  return { archive, ...(backupArchive ? { backupArchive } : {}) };
}
