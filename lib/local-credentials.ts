// Self-hosted local auto-connect (Feature A): read THIS machine's Claude Code credential.
//
// The real work — reading the macOS Keychain (via execFile, no shell) or ~/.claude/.credentials.json,
// and pulling tokens out of the blob — lives in the dependency-free ESM core `credential-source.mjs`,
// which the `bin/connect.mjs` CLI helper ALSO imports so `npx` needs no install. This file is the
// typed surface the Next route imports; it just re-exports the core with TypeScript types.

import type { AccountTokens } from "./types";
// The shared core is plain ESM (Node built-ins only) so the npx CLI can use it too.
import {
  readLocalCredentialRaw as _readLocalCredentialRaw,
  extractTokens as _extractTokens,
  LocalCredentialError as _LocalCredentialError,
  KEYCHAIN_SERVICE as _KEYCHAIN_SERVICE,
} from "./credential-source.mjs";

export interface CredentialDeps {
  platform?: NodeJS.Platform | string;
  execFile?: (cmd: string, args: string[]) => Promise<string>;
  readFile?: (file: string) => Promise<string>;
  homedir?: () => string;
}

export interface LocalCredentialErrorLike extends Error {
  recommendation: string;
}

export const KEYCHAIN_SERVICE: string = _KEYCHAIN_SERVICE;

// Re-exported so `instanceof` / `catch` narrowing works for route callers.
export const LocalCredentialError = _LocalCredentialError as unknown as {
  new (message: string, recommendation: string): LocalCredentialErrorLike;
};

/** Read this machine's raw Claude Code credential JSON (throws LocalCredentialError if not found). */
export function readLocalCredentialRaw(deps?: CredentialDeps): Promise<string> {
  return _readLocalCredentialRaw(deps as never) as Promise<string>;
}

/** Pull `{ accessToken, refreshToken, expiresAt }` out of a raw credential blob. */
export function extractTokens(raw: string): AccountTokens {
  return _extractTokens(raw) as AccountTokens;
}

// Reading a local CLI credential is safe only when the server is running on the same machine as the
// browser. Development enables it by default. A production-mode local install may opt in explicitly;
// remote/serverless deployments remain inert and can use paste or pairing instead.
export function localConnectAvailable(): boolean {
  if (process.env.VERCEL) return false;
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_LOCAL_CONNECT === "1";
}
