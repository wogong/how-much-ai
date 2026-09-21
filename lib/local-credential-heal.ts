// Self-healing for the same-machine shortcut: when Anthropic hard-rejects a shared CLI login, the
// Claude Code CLI on this machine has usually rotated it already. Kept separate from
// local-credentials.ts so that module stays importable without the Anthropic client.

import { fetchProfile } from "./anthropic";
import { parseCredentials } from "./credentials";
import { localConnectAvailable, readLocalCredentialRaw } from "./local-credentials";
import type { AccountTokens, StoredAccount } from "./types";

// A shared CLI login and this app hold the same single-use refresh token, so whichever renews first
// strands the other. When Anthropic hard-rejects the app's copy, the CLI on this machine has usually
// rotated it already. Re-read the local credential and hand back a pair that (a) differs from the
// dead one and (b) is verified via the profile endpoint to belong to the same account. Never spends
// a refresh token: an expired local access token cannot be verified without rotating it, so it is
// left alone and the caller falls through to the normal reauth outcome.
export async function readLocalReplacementTokens(
  account: StoredAccount,
  deadRefreshToken: string,
): Promise<AccountTokens | null> {
  if (!localConnectAvailable()) return null;
  if (account.credentialKind !== "rotating" || account.sub2api) return null;
  if (account.provider && account.provider !== "anthropic") return null;

  let raw: string;
  try {
    raw = await readLocalCredentialRaw();
  } catch {
    return null;
  }
  const parsed = parseCredentials(raw);
  const tokens = parsed?.tokens;
  if (!tokens?.refreshToken || tokens.refreshToken === deadRefreshToken) return null;

  try {
    const profile = await fetchProfile(tokens.accessToken);
    if (profile.account?.uuid !== account.id) return null;
  } catch {
    return null;
  }
  return tokens;
}
