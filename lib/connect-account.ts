// Shared "resolve an account from tokens, then add it to a user's vault" logic — used by BOTH connect
// flows (the local route and the self-hosted pairing "complete" route). It resolves identity
// using the supplied access token without rotating an unsaved credential, dedupes by account id,
// and returns ONLY display info — never the token.

import crypto from "node:crypto";
import { AnthropicError, fetchProfile } from "./anthropic";
import { LONG_LIVED_TOKEN_LIFETIME_MS } from "./credentials";
import { clearAccountUsageState } from "./usage-service";
import { planLabel } from "./format";
import { getProvider } from "./providers/index";
import { mutateAccounts } from "./vault";
import type { AccountCredentialKind, AccountTokens, ProfileData, StoredAccount } from "./types";
import type { ProviderId, ProviderProfile } from "./providers/types";

export class ProfileUnavailableAccountError extends Error {
  readonly status: 409 | 422;

  constructor(message: string, status: 409 | 422) {
    super(message);
    this.name = "ProfileUnavailableAccountError";
    this.status = status;
  }
}

export interface ConnectedAccountInfo {
  id: string;
  email: string;
  plan: string;
  label: string; // a friendly display name (full name if we have one, else the email)
  alreadyConnected: boolean; // true → this account was already in the vault (we just refreshed it)
}

const VERIFIED_UNKNOWN_EXPIRY_MS = 8 * 60 * 60_000;
const PROFILE_UNAVAILABLE_EMAIL = "Email unavailable";
const PROFILE_UNAVAILABLE_PLAN = "Claude";
const PROFILE_UNAVAILABLE_LABEL = "Dedicated monitor token";
const DEDICATED_ID_DOMAIN = "how-much-claude:dedicated-token-account:v1\0";

// A setup token is high-entropy credential material. Hashing it with a domain separator creates a
// deterministic, non-reversible local dedupe key without storing or reflecting the token itself.
export function dedicatedTokenAccountId(accessToken: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(DEDICATED_ID_DOMAIN)
    .update(accessToken)
    .digest("hex");
  return `setup-token-${digest}`;
}

// Resolve identity from the existing bearer token without ever spending a rotating refresh token.
// Connection still has account-target and durable-vault checks ahead of it; rotating here could
// consume the single-use refresh grant before those checks succeed and strand both app + CLI.
export async function resolveAccount(
  tokens: AccountTokens,
): Promise<{ profile: ProfileData; tokens: AccountTokens }> {
  if (!tokens.accessToken) {
    throw new AnthropicError(
      "No usable access token was found. Use the private app login, or copy the legacy Claude Code credential again.",
      401,
    );
  }

  try {
    const profile = await fetchProfile(tokens.accessToken);
    return { profile, tokens };
  } catch (err) {
    if (err instanceof AnthropicError && err.status === 401) {
      throw new AnthropicError(
        tokens.refreshToken
          ? "This shared Claude Code login already rotated. Reconnect with the private app login instead."
          : "This legacy access-only token expired or was revoked. Reconnect with the private app login instead.",
        401,
      );
    }
    throw err;
  }
}

// Build the StoredAccount record from a resolved profile + tokens.
export function buildStoredAccount(
  profile: ProfileData,
  tokens: AccountTokens,
  now = Date.now(),
  credentialKindOverride?: AccountCredentialKind,
): StoredAccount {
  if (!profile.account?.uuid) {
    throw new Error("Claude verified the credential but did not return a stable account identity.");
  }
  const durableTokens =
    tokens.refreshToken && tokens.expiresAt <= 0
      ? { ...tokens, expiresAt: now + VERIFIED_UNKNOWN_EXPIRY_MS }
      : tokens;
  const credentialKind =
    credentialKindOverride ?? (durableTokens.refreshToken === null ? "long_lived" : "rotating");
  if (credentialKind === "long_lived" && durableTokens.refreshToken !== null) {
    throw new Error("A long-lived setup token cannot contain a refresh token.");
  }
  if ((credentialKind === "rotating" || credentialKind === "managed") && durableTokens.refreshToken === null) {
    throw new Error(`${credentialKind === "managed" ? "A managed app login" : "A rotating login"} requires a refresh token.`);
  }
  return {
    id: profile.account.uuid,
    email: profile.account.email ?? "unknown account",
    fullName: profile.account.full_name ?? undefined,
    plan: planLabel(profile),
    addedAt: now,
    credentialKind,
    tokens: durableTokens,
  };
}

// Persist a resolved account into `userId`'s vault, deduped by account id. On a duplicate we keep the
// user's nickname + original addedAt and just refresh email/plan/tokens. Returns display info only.
export async function saveResolvedAccount(
  userId: string,
  profile: ProfileData,
  tokens: AccountTokens,
  credentialKindOverride?: AccountCredentialKind,
): Promise<ConnectedAccountInfo> {
  return persistStoredAccount(userId, buildStoredAccount(profile, tokens, Date.now(), credentialKindOverride));
}

// Dedupe-by-id persistence shared by every connect path. On a duplicate we keep the user's nickname
// and original addedAt and refresh the rest. The serialized mutation prevents simultaneous connects
// from overwriting one another. Fresh tokens supersede cached reauthentication/cooldown state.
export async function persistStoredAccount(userId: string, account: StoredAccount): Promise<ConnectedAccountInfo> {
  let alreadyConnected = false;
  await mutateAccounts(userId, async (existing) => {
    const idx = existing.findIndex((a) => a.id === account.id);
    const next: StoredAccount[] =
      idx >= 0
        ? existing.map((a, i) => (i === idx ? { ...account, label: a.label, addedAt: a.addedAt } : a))
        : [...existing, account];
    alreadyConnected = idx >= 0;
    return next;
  });
  await clearAccountUsageState(userId, account.id).catch(() => {});
  return {
    id: account.id,
    email: account.email,
    plan: account.plan,
    label: account.fullName || account.email,
    alreadyConnected,
  };
}

// --- Generic provider connect path -------------------------------------------------------------
// Anthropic keeps its richer profile-based flow above (dedicated setup tokens, managed OAuth scopes,
// inference-only profile-permission handling). Providers that fit the normalized ProviderProfile
// identity — currently OpenAI — connect through these helpers instead.

export function buildProviderAccount(
  identity: ProviderProfile,
  tokens: AccountTokens,
  providerId: ProviderId,
  now = Date.now(),
): StoredAccount {
  const credentialKind: AccountCredentialKind = tokens.refreshToken === null ? "long_lived" : "rotating";
  return {
    id: identity.id,
    email: identity.email,
    ...(identity.fullName ? { fullName: identity.fullName } : {}),
    plan: identity.plan,
    addedAt: now,
    credentialKind,
    ...(providerId !== "anthropic" ? { provider: providerId } : {}),
    tokens,
  };
}

// Verify a credential against its provider and return the normalized identity (no vault write).
export async function resolveProviderAccount(
  tokens: AccountTokens,
  providerId: ProviderId,
): Promise<{ identity: ProviderProfile; tokens: AccountTokens }> {
  const identity = await getProvider(providerId).resolveIdentity(tokens);
  return { identity, tokens };
}

// Persist a resolved provider identity into the user's vault (deduped by provider account id).
export async function saveProviderAccount(
  userId: string,
  identity: ProviderProfile,
  tokens: AccountTokens,
  providerId: ProviderId,
): Promise<ConnectedAccountInfo> {
  return persistStoredAccount(userId, buildProviderAccount(identity, tokens, providerId));
}

// Some dedicated setup tokens can read usage while Anthropic withholds the profile endpoint. They
// are still safe to persist because they never rotate. A new account gets explicitly synthetic
// metadata and a token-hash identity. A targeted reconnect is safe only when that selected identity
// is the deterministic identity of this exact token; without profile data, no other ownership link
// can be proved. Profile-less credentials must never be attached to a known account identity.
export async function saveDedicatedAccountWithoutProfile(
  userId: string,
  tokens: AccountTokens,
  expectedAccountId?: string,
  now = Date.now(),
): Promise<ConnectedAccountInfo> {
  if (tokens.refreshToken !== null) {
    throw new ProfileUnavailableAccountError(
      "Claude did not provide an account profile. Only a dedicated setup token can be saved without profile data.",
      422,
    );
  }
  if (!tokens.accessToken.trim()) {
    throw new ProfileUnavailableAccountError("The dedicated setup token is missing.", 422);
  }

  const localId = dedicatedTokenAccountId(tokens.accessToken);
  const durableTokens: AccountTokens = {
    ...tokens,
    expiresAt: tokens.expiresAt > 0 ? tokens.expiresAt : now + LONG_LIVED_TOKEN_LIFETIME_MS,
  };
  let alreadyConnected = false;

  const savedAccounts = await mutateAccounts(userId, async (existing) => {
    let next: StoredAccount[];
    if (expectedAccountId) {
      if (expectedAccountId !== localId) {
        throw new ProfileUnavailableAccountError(
          "Claude did not provide a profile, so this token cannot be proven to belong to the selected account. Add it as a separate dedicated token or use the private app login.",
          409,
        );
      }
      const targetIndex = existing.findIndex((account) => account.id === expectedAccountId);
      if (targetIndex < 0) {
        throw new ProfileUnavailableAccountError(
          "The account being reconnected no longer exists. Refresh the dashboard and try again.",
          409,
        );
      }
      const target = existing[targetIndex];
      const targetIsLongLived =
        target.credentialKind === "long_lived" ||
        (target.credentialKind === undefined && target.tokens.refreshToken === null);
      if (!targetIsLongLived) {
        throw new ProfileUnavailableAccountError(
          "Claude did not provide a profile, so this token cannot safely replace the selected shared CLI login. Use the private app login instead.",
          409,
        );
      }

      const updated: StoredAccount = { ...target, credentialKind: "long_lived", tokens: durableTokens };
      next = existing.map((account, index) => (index === targetIndex ? updated : account));
      alreadyConnected = true;
    } else {
      const existingIndex = existing.findIndex((account) => account.id === localId);
      if (existingIndex >= 0) {
        const previous = existing[existingIndex];
        const previousIsLongLived =
          previous.credentialKind === "long_lived" ||
          (previous.credentialKind === undefined && previous.tokens.refreshToken === null);
        if (!previousIsLongLived) {
          throw new ProfileUnavailableAccountError(
            "The generated local identity conflicts with a rotating account. No credentials were changed.",
            409,
          );
        }
        const updated: StoredAccount = { ...previous, credentialKind: "long_lived", tokens: durableTokens };
        next = existing.map((account, index) => (index === existingIndex ? updated : account));
        alreadyConnected = true;
      } else {
        const created: StoredAccount = {
          id: localId,
          email: PROFILE_UNAVAILABLE_EMAIL,
          label: PROFILE_UNAVAILABLE_LABEL,
          plan: PROFILE_UNAVAILABLE_PLAN,
          addedAt: now,
          credentialKind: "long_lived",
          tokens: durableTokens,
        };
        next = [...existing, created];
      }
    }

    return next;
  });

  const savedId = expectedAccountId ?? localId;
  const savedAccount = savedAccounts.find((account) => account.id === savedId);
  if (!savedAccount) throw new Error("The access-only credential could not be saved.");
  await clearAccountUsageState(userId, savedAccount.id).catch(() => {});
  return {
    id: savedAccount.id,
    email: savedAccount.email,
    plan: savedAccount.plan,
    label: savedAccount.label || savedAccount.fullName || savedAccount.email,
    alreadyConnected,
  };
}

// One-shot: resolve raw tokens → add to vault. Used by the self-hosted local-connect route.
export async function connectAccountFromTokens(userId: string, tokens: AccountTokens): Promise<ConnectedAccountInfo> {
  const { profile, tokens: resolved } = await resolveAccount(tokens);
  return saveResolvedAccount(userId, profile, resolved);
}
