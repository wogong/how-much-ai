// Server-side encrypted storage for the connected accounts ("the vault").
// Runs only in route handlers (Node runtime). The accounts blob is AES-256-GCM encrypted
// with a server key before it ever touches storage, so a leak of the storage backend alone
// doesn't expose tokens.
//
// Every self-hosted read/write uses the stable `default` tenant. The internal userId parameter and
// scoped-key helper remain for stored-data compatibility, while the HTTP boundary never accepts a
// tenant from the client.
//
// Backend is auto-detected:
//   - Convex (CONVEX_URL + VAULT_ACCESS_SECRET) → use it.
//   - Redis/KV (KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + _TOKEN).
//   - Otherwise → a local file (.data/vault.enc). Zero-config for running on your own machine.

import crypto from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { scopedKey } from "./app-config";
import { withLocalVaultMutationLock } from "./local-file-lock";
import { normalizeSub2ApiUrl, validSub2ApiAccountId } from "./sub2api-config";
import type { AccountCredentialKind, AccountTokens, StoredAccount } from "./types";
import type { ProviderId } from "./providers/types";

// Storage-key bases. Kept distinct per backend to preserve the exact historical keys of the
// shared/default tenant (Convex rows were keyed "accounts"; redis used "usage:vault:v1").
const CONVEX_BASE = "accounts";
const CONVEX_BACKUP_BASE = "accounts-last-good";
const CONVEX_KEY_PROOF_BASE = "accounts-key-proof";
const REDIS_BASE = "usage:vault:v1";
const REDIS_BACKUP_BASE = "usage:vault:last-good:v1";
const REDIS_KEY_PROOF_KEY = "usage:vault:key-proof:v1";
const RECOVERY_CONVEX_BASE = "token-recovery";
const RECOVERY_REDIS_BASE = "usage:token-recovery:v1";

const LOCAL_FALLBACK_SECRET = "usage-local-open-mode-key-v1";
const keyCache = new Map<string, Buffer>();
let generatedLocalSecret: string | null = null;

type VaultSecretEnvironmentName = "VAULT_ENCRYPTION_SECRET" | "VAULT_ACCESS_SECRET" | "APP_PASSWORD";

// Environment UIs and copied shell output can accidentally add surrounding whitespace. New
// ciphertext and backend authentication use one canonical, trimmed value so a successful write is
// always readable by the same configuration. Decryption also retains the exact raw value because
// older releases derived keys directly from process.env and may already have persisted such a blob.
function normalizedEnvironmentValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function configuredEncryptionSecret(): string | null {
  return (
    normalizedEnvironmentValue("VAULT_ENCRYPTION_SECRET") ||
    normalizedEnvironmentValue("VAULT_ACCESS_SECRET") ||
    normalizedEnvironmentValue("APP_PASSWORD")
  );
}

function decryptionEnvironmentVariants(name: VaultSecretEnvironmentName): string[] {
  const raw = process.env[name];
  const normalized = normalizedEnvironmentValue(name);
  return [normalized, raw].filter(
    (secret, index, all): secret is string =>
      typeof secret === "string" && secret.length > 0 && all.indexOf(secret) === index,
  );
}

function localKeyFile(): string {
  const dataDir = process.env.VAULT_DATA_DIR || path.join(process.cwd(), ".data");
  return path.join(dataDir, "vault.key");
}

function existingLocalEncryptionSecret(): string | null {
  if (generatedLocalSecret) return generatedLocalSecret;
  try {
    const existing = readFileSync(localKeyFile(), "utf8").trim();
    if (existing.length < 32) throw new Error("Local vault key is invalid");
    chmodSync(localKeyFile(), 0o600);
    generatedLocalSecret = existing;
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// All writes in one app process share this per-user queue. The storage backends hold one encrypted
// array, so an account mutation has to keep its read + transform + write together or two callers can
// both read the same version and silently discard one another's changes.
const mutationQueues = new Map<string, Promise<void>>();

// New blobs prefer a dedicated, stable encryption secret. VAULT_ACCESS_SECRET is already required
// by hosted Convex deployments and is a high-entropy stable fallback; APP_PASSWORD is retained only
// for backward-compatible/self-hosted setups. Existing blobs remain key-sticky: a mutation encrypts
// with the exact candidate that successfully decrypted its current generation, so adding or changing
// a preferred environment variable can never silently re-key a shared remote vault.
function localEncryptionSecret(): string {
  const existingSecret = existingLocalEncryptionSecret();
  if (existingSecret) return existingSecret;
  const dataDir = process.env.VAULT_DATA_DIR || path.join(process.cwd(), ".data");
  const keyFile = localKeyFile();

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const created = crypto.randomBytes(32).toString("base64url");
  try {
    writeFileSync(keyFile, created, { encoding: "utf8", flag: "wx", mode: 0o600 });
    generatedLocalSecret = created;
    return created;
  } catch (error) {
    // Another local process may have won the exclusive create race. Adopt only its complete key.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readFileSync(keyFile, "utf8").trim();
    if (existing.length < 32) throw new Error("Local vault key is invalid");
    generatedLocalSecret = existing;
    return existing;
  }
}

function encryptionSecret(): string {
  return configuredEncryptionSecret() || localEncryptionSecret();
}

function encryptionKey(secret = encryptionSecret()): Buffer {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  // Fixed salt: the salt just domain-separates the key; the secret above provides the entropy.
  const key = crypto.scryptSync(secret, "usage.vault.salt.v1", 32);
  keyCache.set(secret, key);
  return key;
}

function encrypt(plaintext: string, secret = encryptionSecret()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function keyProof(secret: string): string {
  return crypto.createHmac("sha256", secret).update("how-much-claude:vault-key-proof:v1").digest("hex");
}

function decryptParts(ivB64: string, tagB64: string, dataB64: string, secret: string): string {
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("malformed vault blob");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

interface DecryptedValue {
  plaintext: string;
  secret: string;
}

function decryptionCandidates(): string[] {
  // A remote vault must never inspect a bundled/local key file. Besides being irrelevant to a
  // shared backend, serverless filesystems can expose a traced file as read-only: the chmod used to
  // enforce local 0600 permissions would then throw EROFS before the valid remote key is attempted.
  const local = storageBackend() === "file";
  const preferredSecret = local ? encryptionSecret() : configuredEncryptionSecret() || LOCAL_FALLBACK_SECRET;
  const existingLocalSecret = local ? existingLocalEncryptionSecret() : null;
  return [
    preferredSecret,
    ...decryptionEnvironmentVariants("VAULT_ENCRYPTION_SECRET"),
    ...decryptionEnvironmentVariants("VAULT_ACCESS_SECRET"),
    ...decryptionEnvironmentVariants("APP_PASSWORD"),
    existingLocalSecret,
    LOCAL_FALLBACK_SECRET,
  ].filter((secret, index, all): secret is string => Boolean(secret) && all.indexOf(secret) === index);
}

function decryptWithSecret(blob: string): DecryptedValue {
  const parts = blob.split(":");
  if (parts[0] === "v2") {
    if (parts.length !== 4) throw new Error("malformed vault blob");
    // Try current supported stable sources so an operator can add VAULT_ENCRYPTION_SECRET after a
    // vault was initially written with the hosted access secret or local fallback.
    for (const secret of decryptionCandidates()) {
      try {
        return { plaintext: decryptParts(parts[1], parts[2], parts[3], secret), secret };
      } catch {
        // Try another supported key source; callers receive one generic corruption/key error.
      }
    }
    throw new Error("vault authentication failed");
  }
  if (parts.length !== 3) throw new Error("malformed vault blob");

  // Historical releases selected APP_PASSWORD first, then VAULT_ENCRYPTION_SECRET, then the local
  // fallback. Try each unique candidate so operators can add a stable key without first rewriting
  // the vault under the old password. A later successful mutation writes the versioned v2 format.
  const local = storageBackend() === "file";
  const legacySecrets = [
    ...decryptionEnvironmentVariants("APP_PASSWORD"),
    ...decryptionEnvironmentVariants("VAULT_ENCRYPTION_SECRET"),
    LOCAL_FALLBACK_SECRET,
    ...decryptionEnvironmentVariants("VAULT_ACCESS_SECRET"),
    local ? encryptionSecret() : configuredEncryptionSecret() || LOCAL_FALLBACK_SECRET,
  ].filter((secret, index, all): secret is string => Boolean(secret) && all.indexOf(secret) === index);
  for (const secret of legacySecrets) {
    try {
      return { plaintext: decryptParts(parts[0], parts[1], parts[2], secret), secret };
    } catch {
      // Try the next historical key candidate; callers receive one generic corruption/key error.
    }
  }
  throw new Error("vault authentication failed");
}

function decrypt(blob: string): string {
  return decryptWithSecret(blob).plaintext;
}

// --- storage backends ---------------------------------------------------------

export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export class VaultEncryptionKeyMismatchError extends Error {
  constructor() {
    super("Vault encryption key mismatch");
    this.name = "VaultEncryptionKeyMismatchError";
  }
}

function throwMappedKeyMismatch(error: unknown): never {
  if (error instanceof Error && error.message.includes("Vault encryption key mismatch")) {
    throw new VaultEncryptionKeyMismatchError();
  }
  throw error;
}

export class VaultRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultRecoveryError";
  }
}

type StorageSelection =
  | { type: "convex"; config: { url: string; secret: string } }
  | { type: "redis"; config: { url: string; token: string } }
  | { type: "file" };

const env = normalizedEnvironmentValue;

function pairedRemoteConfig(
  label: string,
  urlName: string,
  tokenName: string,
): { url: string; token: string } | null {
  const url = env(urlName);
  const token = env(tokenName);
  if (Boolean(url) !== Boolean(token)) {
    throw new StorageConfigurationError(
      `${label} storage is partially configured; set both ${urlName} and ${tokenName}`,
    );
  }
  return url && token ? { url, token } : null;
}

function storageSelection(): StorageSelection {
  const explicitConvexUrl = env("CONVEX_URL");
  const publicConvexUrl = env("NEXT_PUBLIC_CONVEX_URL");
  const convexSecret = env("VAULT_ACCESS_SECRET");
  // `npx convex dev` writes NEXT_PUBLIC_CONVEX_URL for browser clients. That public URL alone must
  // not opt a zero-config local app into the secret-gated server vault. An explicit server URL, or
  // a vault secret paired with either URL, is an intentional Convex storage configuration.
  const convexRequested = Boolean(explicitConvexUrl || convexSecret);
  const convexUrl = explicitConvexUrl ?? (convexSecret ? publicConvexUrl : null);
  if (convexRequested && (!convexUrl || !convexSecret)) {
    throw new StorageConfigurationError(
      "Convex storage is partially configured; set both CONVEX_URL and VAULT_ACCESS_SECRET",
    );
  }

  if (convexUrl && convexSecret) {
    return { type: "convex", config: { url: convexUrl, secret: convexSecret } };
  }

  const kv = pairedRemoteConfig("Redis/KV", "KV_REST_API_URL", "KV_REST_API_TOKEN");
  const upstash = pairedRemoteConfig(
    "Upstash Redis",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  );
  if (kv ?? upstash) {
    return { type: "redis", config: (kv ?? upstash)! };
  }

  if (Boolean(env("VERCEL"))) {
    throw new StorageConfigurationError(
      "Vercel deployments require durable Convex or Redis vault storage; local files are not durable there",
    );
  }
  return { type: "file" };
}

// Per-tenant local file. The self-hosted `default` tenant keeps the historical path
// (`.data/vault.enc`); sanitized suffixes preserve compatibility for imported data.
function fileFor(userId: string): string {
  const suffix = userId === "default" ? "" : `-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  // Tests and embedders can isolate vault files without changing cwd. The default remains the
  // historical .data path, so existing local vaults continue to be discovered unchanged.
  const dataDir = process.env.VAULT_DATA_DIR || path.join(process.cwd(), ".data");
  return path.join(dataDir, `vault${suffix}.enc`);
}

function backupFileFor(userId: string): string {
  return `${fileFor(userId)}.last-good`;
}

function recoveryFileFor(userId: string, accountId: string): string {
  const tenant = userId === "default" ? "default" : crypto.createHash("sha256").update(userId).digest("hex").slice(0, 24);
  const account = crypto.createHash("sha256").update(accountId).digest("hex");
  const dataDir = process.env.VAULT_DATA_DIR || path.join(process.cwd(), ".data");
  return path.join(dataDir, "token-recovery", `${tenant}-${account}.enc`);
}

async function writePrivateFileAtomically(file: string, value: string): Promise<void> {
  const dir = path.dirname(file);
  const dataDir = process.env.VAULT_DATA_DIR || path.join(process.cwd(), ".data");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  if (dir !== dataDir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw err;
  }
}

export const REDIS_STORAGE_TIMEOUT_MS = 8_000;

async function redisCommand(cfg: { url: string; token: string }, command: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: AbortSignal.timeout(REDIS_STORAGE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new Error(timedOut ? "Redis storage request timed out" : "Redis storage request failed");
  }
  if (!res.ok) throw new Error(`storage error ${res.status}`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("Redis storage returned an invalid response");
  }
  if (!record(data) || !Object.prototype.hasOwnProperty.call(data, "result")) {
    throw new Error("Redis storage returned an invalid response");
  }
  return data.result;
}

async function readRaw(userId: string): Promise<string | null> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    return (await client.query(anyApi.vault.get, {
      secret: storage.config.secret,
      key: scopedKey(CONVEX_BASE, userId),
    })) as
      | string
      | null;
  }
  if (storage.type === "redis") {
    return (await redisCommand(storage.config, ["GET", scopedKey(REDIS_BASE, userId)])) as string | null;
  }
  try {
    return await fs.readFile(fileFor(userId), "utf8");
  } catch (err) {
    // A missing file is a new/empty vault. Permission errors, directories at the file path, I/O
    // errors, and every other failure must surface rather than masquerading as an empty vault.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

async function readBackupRaw(userId: string): Promise<string | null> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    return (await client.query(anyApi.vault.get, {
      secret: storage.config.secret,
      key: scopedKey(CONVEX_BACKUP_BASE, userId),
    })) as string | null;
  }
  if (storage.type === "redis") {
    return (await redisCommand(storage.config, ["GET", scopedKey(REDIS_BACKUP_BASE, userId)])) as string | null;
  }
  try {
    return await fs.readFile(backupFileFor(userId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function readStoredKeyProof(userId: string): Promise<string | null> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    return (await client.query(anyApi.vault.get, {
      secret: storage.config.secret,
      key: scopedKey(CONVEX_KEY_PROOF_BASE, userId),
    })) as string | null;
  }
  if (storage.type === "redis") {
    return (await redisCommand(storage.config, ["GET", scopedKey(REDIS_KEY_PROOF_KEY, userId)])) as string | null;
  }
  return null;
}

const REDIS_MISSING_SENTINEL = "__HMC_VAULT_MISSING__";
const REDIS_COMPARE_AND_SET = [
  "local current = redis.call('GET', KEYS[1])",
  "local expected = ARGV[1]",
  `local matches = (expected == '${REDIS_MISSING_SENTINEL}' and current == false) or current == expected`,
  "if not matches then return 0 end",
  "local proof = redis.call('GET', KEYS[3])",
  "if proof and proof ~= ARGV[3] then return -1 end",
  "if not proof then redis.call('SET', KEYS[3], ARGV[3]) end",
  "redis.call('SET', KEYS[2], ARGV[2])",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1",
].join("\n");

const REDIS_RESTORE_BACKUP = [
  "local current = redis.call('GET', KEYS[1])",
  "local backup = redis.call('GET', KEYS[2])",
  "local expected = ARGV[1]",
  `local main_matches = (expected == '${REDIS_MISSING_SENTINEL}' and current == false) or current == expected`,
  "if not main_matches or backup ~= ARGV[2] then return 0 end",
  "local proof = redis.call('GET', KEYS[3])",
  "if proof and proof ~= ARGV[3] then return -1 end",
  "if not proof then redis.call('SET', KEYS[3], ARGV[3]) end",
  "redis.call('SET', KEYS[1], backup)",
  "return 1",
].join("\n");

const REDIS_AUX_COMPARE_AND_SET = [
  "local current = redis.call('GET', KEYS[1])",
  "local expected = ARGV[1]",
  `local matches = (expected == '${REDIS_MISSING_SENTINEL}' and current == false) or current == expected`,
  "if not matches then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1",
].join("\n");

// Cross-instance compare-and-set for the shared remote backends. Convex performs this in one
// transactional mutation; Redis executes the compare and SET in one Lua script. Local-file mode is
// process-local by design, and its caller is already protected by mutationQueues.
async function compareAndSetRaw(
  userId: string,
  expected: string | null,
  value: string,
  proof: string,
): Promise<boolean> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    try {
      return (await client.mutation(anyApi.vault.compareAndSet, {
        secret: storage.config.secret,
        key: scopedKey(CONVEX_BASE, userId),
        expected,
        data: value,
        backupKey: scopedKey(CONVEX_BACKUP_BASE, userId),
        proofKey: scopedKey(CONVEX_KEY_PROOF_BASE, userId),
        keyProof: proof,
      })) as boolean;
    } catch (error) {
      throwMappedKeyMismatch(error);
    }
  }
  if (storage.type === "redis") {
    const result = await redisCommand(storage.config, [
      "EVAL",
      REDIS_COMPARE_AND_SET,
      "3",
      scopedKey(REDIS_BASE, userId),
      scopedKey(REDIS_BACKUP_BASE, userId),
      scopedKey(REDIS_KEY_PROOF_KEY, userId),
      expected ?? REDIS_MISSING_SENTINEL,
      value,
      proof,
    ]);
    if (Number(result) === -1) throw new VaultEncryptionKeyMismatchError();
    return Number(result) === 1;
  }
  const current = await readRaw(userId);
  if (current !== expected) return false;
  // The value has already been parsed and validated by the caller. Write the recoverable generation
  // first, then publish the same bytes as main; a crash before the second rename cannot make a spent
  // or deleted predecessor the canonical backup of a successful write.
  await writePrivateFileAtomically(backupFileFor(userId), value);
  await writePrivateFileAtomically(fileFor(userId), value);
  return true;
}

async function restoreBackupRaw(
  userId: string,
  expectedMain: string | null,
  expectedBackup: string,
  proof: string,
  localLockHeld = false,
): Promise<boolean> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    try {
      return (await client.mutation(anyApi.vault.restoreBackup, {
        secret: storage.config.secret,
        key: scopedKey(CONVEX_BASE, userId),
        backupKey: scopedKey(CONVEX_BACKUP_BASE, userId),
        expectedMain,
        expectedBackup,
        keyProof: proof,
        proofKey: scopedKey(CONVEX_KEY_PROOF_BASE, userId),
      })) as boolean;
    } catch (error) {
      throwMappedKeyMismatch(error);
    }
  }
  if (storage.type === "redis") {
    const result = await redisCommand(storage.config, [
      "EVAL",
      REDIS_RESTORE_BACKUP,
      "3",
      scopedKey(REDIS_BASE, userId),
      scopedKey(REDIS_BACKUP_BASE, userId),
      scopedKey(REDIS_KEY_PROOF_KEY, userId),
      expectedMain ?? REDIS_MISSING_SENTINEL,
      expectedBackup,
      proof,
    ]);
    if (Number(result) === -1) throw new VaultEncryptionKeyMismatchError();
    return Number(result) === 1;
  }

  const restore = async () => {
    const [current, backup] = await Promise.all([readRaw(userId), readBackupRaw(userId)]);
    if (current !== expectedMain || backup !== expectedBackup) return false;
    await writePrivateFileAtomically(fileFor(userId), expectedBackup);
    return true;
  };
  return localLockHeld ? restore() : withLocalVaultMutationLock(userId, restore);
}

export function storageBackend(): "convex" | "redis" | "file" {
  return storageSelection().type;
}

// Deliberately awkward: recovery removes the active pathname from service, so a caller must send
// this exact phrase rather than accidentally triggering the operation with a generic boolean.
export const VAULT_RECOVERY_CONFIRMATION = "ARCHIVE_UNREADABLE_VAULT";

export interface VaultRecoveryResult {
  archive: string;
  backupArchive?: string;
}

// Preserve an unreadable local vault byte-for-byte under a non-sensitive archive name, then leave
// the canonical path absent so the app can start with an empty vault. This is intentionally much
// narrower than a general reset API: readable vaults, missing vaults, remote backends, directories,
// and symlinks are all rejected. The existing vault.key is never read for mutation or removed.
export async function recoverUnreadableLocalVault(userId: string): Promise<VaultRecoveryResult> {
  const backend = storageBackend();
  if (backend !== "file") {
    throw new VaultRecoveryError(
      `Unreadable-vault recovery is only available for local file storage. This app uses ${backend} storage; restore the matching encryption secret or recover the saved value in that backend.`,
    );
  }

  return serializeForUser(userId, () =>
    withLocalVaultMutationLock(userId, async () => {
      const source = fileFor(userId);
      let before: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        before = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new VaultRecoveryError("There is no local saved-account vault to archive.");
        }
        throw error;
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new VaultRecoveryError(
          "The local vault path is not a regular file. It was left untouched and must be inspected manually.",
        );
      }

      const dir = path.dirname(source);
      // Older releases could leave the data directory or a legacy vault/archive world-readable.
      // Tighten both before reading or renaming so recovery can never preserve those permissions.
      await fs.chmod(dir, 0o700);
      await fs.chmod(source, 0o600);

      const raw = await fs.readFile(source, "utf8");
      let unreadable = false;
      try {
        parseRawAccounts(raw);
      } catch {
        // This is the one permitted state: the same operation used by loadAccounts cannot read the
        // current bytes. Never include its encryption/schema detail in the archive name or response.
        unreadable = true;
      }
      if (!unreadable) {
        throw new VaultRecoveryError(
          "The saved-account vault is readable, so recovery was refused. Reload the saved accounts instead.",
        );
      }

      const backupSource = backupFileFor(userId);
      let backupBefore: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      let unreadableBackupRaw: string | null = null;
      try {
        backupBefore = await fs.lstat(backupSource);
        if (!backupBefore.isFile() || backupBefore.isSymbolicLink()) {
          throw new VaultRecoveryError(
            "The local last-known-good backup is not a regular file. Nothing was archived; inspect it manually.",
          );
        }
        await fs.chmod(backupSource, 0o600);
        unreadableBackupRaw = await fs.readFile(backupSource, "utf8");
        try {
          parseRawAccounts(unreadableBackupRaw);
          throw new VaultRecoveryError(
            "A readable last-known-good backup is available. Reload saved accounts so it can be restored automatically.",
          );
        } catch (error) {
          if (error instanceof VaultRecoveryError) throw error;
          // Both generations are unreadable. Preserve both under non-canonical archive names so a
          // successful manual recovery cannot immediately resurrect or trip over the stale backup.
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        backupBefore = null;
        unreadableBackupRaw = null;
      }

      // Refuse to move a path that was replaced between validation and archival. All app writers
      // honor this cross-process lock; this check also fails safe around manual filesystem changes.
      const current = await fs.lstat(source);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs
      ) {
        throw new VaultRecoveryError(
          "The local vault changed while recovery was being prepared. Nothing was archived; retry after reloading.",
        );
      }

      if (backupBefore) {
        const currentBackup = await fs.lstat(backupSource);
        if (
          !currentBackup.isFile() ||
          currentBackup.isSymbolicLink() ||
          currentBackup.dev !== backupBefore.dev ||
          currentBackup.ino !== backupBefore.ino ||
          currentBackup.size !== backupBefore.size ||
          currentBackup.mtimeMs !== backupBefore.mtimeMs
        ) {
          throw new VaultRecoveryError(
            "The local last-known-good backup changed while recovery was being prepared. Nothing was archived; retry after reloading.",
          );
        }
      }

      const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
      const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const nonce = crypto.randomBytes(8).toString("hex");
        const archive = `vault-unreadable-${timestamp}-${digest}-${nonce}.enc`;
        const destination = path.join(dir, archive);
        const backupArchive = unreadableBackupRaw
          ? `vault-unreadable-backup-${timestamp}-${crypto.createHash("sha256").update(unreadableBackupRaw).digest("hex").slice(0, 12)}-${nonce}.enc`
          : null;
        const backupDestination = backupArchive ? path.join(dir, backupArchive) : null;
        try {
          await fs.lstat(destination);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (backupDestination) {
          try {
            await fs.lstat(backupDestination);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }

        // Same-filesystem rename is atomic: after success, either the canonical source or the
        // complete archive name is visible, never a partial copy. A long random suffix plus the
        // existence check keeps the operation from replacing a prior archive.
        if (backupDestination) await fs.rename(backupSource, backupDestination);
        try {
          await fs.rename(source, destination);
        } catch (error) {
          if (backupDestination) {
            try {
              await fs.rename(backupDestination, backupSource);
            } catch {
              throw new VaultRecoveryError(
                `The main vault was left canonical, but its unreadable backup was preserved as ${backupArchive}. Inspect it before retrying recovery.`,
              );
            }
          }
          throw error;
        }
        await fs.chmod(destination, 0o600);
        if (backupDestination) await fs.chmod(backupDestination, 0o600);
        await fs.chmod(dir, 0o700);
        return { archive, ...(backupArchive ? { backupArchive } : {}) };
      }
      throw new VaultRecoveryError("Couldn't allocate a unique local vault archive name. Nothing was changed.");
    }),
  );
}

export interface TokenRecoveryRecord {
  accountId: string;
  expectedRefreshToken: string;
  tokens: AccountTokens;
  createdAt: number;
}

export interface TokenRecoveryGeneration {
  record: TokenRecoveryRecord;
  // Opaque encrypted storage generation used only as a compare-and-set fence. It never crosses a
  // route/browser boundary and prevents an older lease owner from clearing a newer recovery record.
  ciphertext: string;
}

// Recovery journals contain the replacement for a single-use refresh token, so they must follow
// the same key-sticky rule as the main remote vault. Reading the tenant's current generation gives
// us the exact key that decrypted it; the tenant proof then rejects any inconsistent writer before
// credential material is stored under a key another instance may not have.
async function credentialRecordEncryptionSecret(userId: string): Promise<string> {
  if (storageBackend() === "file") return encryptionSecret();

  const state = await readParsedAccounts(userId);
  const secret = state.encryptionSecretUsed ?? (await encryptionSecretForNewVault(userId));
  const storedProof = await readStoredKeyProof(userId);
  if (storedProof !== null && storedProof !== keyProof(secret)) {
    throw new VaultEncryptionKeyMismatchError();
  }
  return secret;
}

function recoveryStorageKey(base: string, userId: string, accountId: string): string {
  return scopedKey(`${base}:${crypto.createHash("sha256").update(accountId).digest("hex")}`, userId);
}

async function readTokenRecoveryRaw(userId: string, accountId: string): Promise<string | null> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    return (await client.query(anyApi.vault.get, {
      secret: storage.config.secret,
      key: recoveryStorageKey(RECOVERY_CONVEX_BASE, userId, accountId),
    })) as string | null;
  }
  if (storage.type === "redis") {
    return (await redisCommand(storage.config, [
      "GET",
      recoveryStorageKey(RECOVERY_REDIS_BASE, userId, accountId),
    ])) as string | null;
  }
  try {
    return await fs.readFile(recoveryFileFor(userId, accountId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function compareAndSetTokenRecoveryRaw(
  userId: string,
  accountId: string,
  expected: string | null,
  value: string,
): Promise<boolean> {
  const storage = storageSelection();
  if (storage.type === "convex") {
    const client = new ConvexHttpClient(storage.config.url);
    return (await client.mutation(anyApi.vault.compareAndSetAuxiliary, {
      secret: storage.config.secret,
      key: recoveryStorageKey(RECOVERY_CONVEX_BASE, userId, accountId),
      expected,
      data: value,
    })) as boolean;
  }
  if (storage.type === "redis") {
    const result = await redisCommand(storage.config, [
      "EVAL",
      REDIS_AUX_COMPARE_AND_SET,
      "1",
      recoveryStorageKey(RECOVERY_REDIS_BASE, userId, accountId),
      expected ?? REDIS_MISSING_SENTINEL,
      value,
    ]);
    return Number(result) === 1;
  }
  return withLocalVaultMutationLock(userId, async () => {
    const current = await readTokenRecoveryRaw(userId, accountId);
    if (current !== expected) return false;
    await writePrivateFileAtomically(recoveryFileFor(userId, accountId), value);
    return true;
  });
}

function parseTokenRecoveryRaw(raw: string | null, accountId: string): TokenRecoveryRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(decrypt(raw));
  } catch {
    throw new Error("The encrypted rotated-token recovery journal is corrupt or uses the wrong encryption secret");
  }
  if (value === null) return null;
  if (!record(value) || !record(value.tokens)) throw new Error("The rotated-token recovery journal is invalid");
  const candidate = value as unknown as TokenRecoveryRecord;
  if (
    candidate.accountId !== accountId ||
    typeof candidate.expectedRefreshToken !== "string" ||
    !candidate.expectedRefreshToken ||
    typeof candidate.tokens.accessToken !== "string" ||
    !candidate.tokens.accessToken ||
    typeof candidate.tokens.refreshToken !== "string" ||
    !candidate.tokens.refreshToken ||
    typeof candidate.tokens.expiresAt !== "number" ||
    !Number.isFinite(candidate.tokens.expiresAt) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt)
  ) {
    throw new Error("The rotated-token recovery journal is invalid");
  }
  return candidate;
}

function sameRecoveryRecord(a: TokenRecoveryRecord, b: TokenRecoveryRecord): boolean {
  return (
    a.accountId === b.accountId &&
    a.expectedRefreshToken === b.expectedRefreshToken &&
    a.tokens.accessToken === b.tokens.accessToken &&
    a.tokens.refreshToken === b.tokens.refreshToken &&
    a.tokens.expiresAt === b.tokens.expiresAt
  );
}

// Rotating refresh grants are single-use. The replacement is journaled in a separate encrypted,
// per-account record before the main vault CAS. If that CAS or the process then fails, the next
// coordinated poll can adopt the replacement instead of retrying the already-spent generation.
export async function saveTokenRecovery(
  record: TokenRecoveryRecord,
  userId: string,
): Promise<TokenRecoveryGeneration> {
  if (
    !record.accountId ||
    !record.expectedRefreshToken ||
    !record.tokens.accessToken ||
    !record.tokens.refreshToken ||
    !Number.isFinite(record.tokens.expiresAt) ||
    !Number.isFinite(record.createdAt)
  ) {
    throw new VaultValidationError("Rotated-token recovery record is invalid");
  }
  const secret = await credentialRecordEncryptionSecret(userId);
  const ciphertext = encrypt(JSON.stringify(record), secret);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentRaw = await readTokenRecoveryRaw(userId, record.accountId);
    const current = parseTokenRecoveryRaw(currentRaw, record.accountId);
    if (current && sameRecoveryRecord(current, record)) {
      return { record: current, ciphertext: currentRaw! };
    }
    // A pending record may be replaced only by the next link in its exact refresh chain. Stale or
    // unrelated lease owners fail without overwriting the sole recoverable replacement credential.
    if (current && current.tokens.refreshToken !== record.expectedRefreshToken) {
      throw new VaultRecoveryError("A different rotated-token recovery generation is already pending");
    }
    if (await compareAndSetTokenRecoveryRaw(userId, record.accountId, currentRaw, ciphertext)) {
      return { record, ciphertext };
    }
  }
  throw new VaultRecoveryError("The rotated-token recovery journal changed repeatedly while saving");
}

export async function loadTokenRecovery(
  userId: string,
  accountId: string,
): Promise<TokenRecoveryGeneration | null> {
  const raw = await readTokenRecoveryRaw(userId, accountId);
  const recovered = parseTokenRecoveryRaw(raw, accountId);
  return recovered && raw ? { record: recovered, ciphertext: raw } : null;
}

export async function clearTokenRecovery(
  userId: string,
  accountId: string,
  generation: TokenRecoveryGeneration,
): Promise<boolean> {
  if (generation.record.accountId !== accountId || !generation.ciphertext) {
    throw new VaultValidationError("Rotated-token recovery generation is invalid");
  }
  // An encrypted tombstone removes all credential material while keeping the operation supported by
  // the secret-gated backends. Exact ciphertext CAS means a stale worker cannot clear a newer record.
  const secret = await credentialRecordEncryptionSecret(userId);
  return compareAndSetTokenRecoveryRaw(
    userId,
    accountId,
    generation.ciphertext,
    encrypt("null", secret),
  );
}

// --- public API ---------------------------------------------------------------

export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_VAULT_ACCOUNTS = 500;
const MAX_ACCOUNT_ID_LENGTH = 200;
const MAX_EMAIL_LENGTH = 512;
const MAX_DISPLAY_FIELD_LENGTH = 1_000;
const MAX_PLAN_LENGTH = 200;
const MAX_TOKEN_LENGTH = 16 * 1024;

function requiredString(
  value: unknown,
  field: string,
  index: number,
  options: { nonEmpty?: boolean; maxLength: number },
): string {
  if (typeof value !== "string" || (options.nonEmpty && value.trim().length === 0)) {
    throw new VaultValidationError(
      `accounts[${index}].${field} must be ${options.nonEmpty ? "a non-empty string" : "a string"}`,
    );
  }
  if (value.length > options.maxLength) {
    throw new VaultValidationError(
      `accounts[${index}].${field} must be at most ${options.maxLength} characters`,
    );
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new VaultValidationError(`accounts[${index}].${field} must be a string when present`);
  }
  if (value.length > MAX_DISPLAY_FIELD_LENGTH) {
    throw new VaultValidationError(
      `accounts[${index}].${field} must be at most ${MAX_DISPLAY_FIELD_LENGTH} characters`,
    );
  }
  return value;
}

// Validate and copy untrusted JSON into the complete StoredAccount shape. Rebuilding each object
// drops unknown/prototype-polluting input instead of persisting it and guarantees callers never get
// a partially shaped account merely because the outer value happened to be an array.
export function parseStoredAccounts(value: unknown): StoredAccount[] {
  if (!Array.isArray(value)) throw new VaultValidationError("accounts must be an array");
  if (value.length > MAX_VAULT_ACCOUNTS) {
    throw new VaultValidationError(`accounts must contain at most ${MAX_VAULT_ACCOUNTS} entries`);
  }

  const accounts = value.map((candidate, index) => {
    if (!record(candidate)) throw new VaultValidationError(`accounts[${index}] must be an object`);
    if (!record(candidate.tokens)) throw new VaultValidationError(`accounts[${index}].tokens must be an object`);

    const addedAt = candidate.addedAt;
    if (typeof addedAt !== "number" || !Number.isFinite(addedAt) || addedAt < 0) {
      throw new VaultValidationError(`accounts[${index}].addedAt must be a non-negative finite number`);
    }

    const expiresAt = candidate.tokens.expiresAt;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt < 0) {
      throw new VaultValidationError(`accounts[${index}].tokens.expiresAt must be a non-negative finite number`);
    }

    const refreshToken = candidate.tokens.refreshToken;
    if (refreshToken !== null && typeof refreshToken !== "string") {
      throw new VaultValidationError(`accounts[${index}].tokens.refreshToken must be a string or null`);
    }
    if (
      typeof refreshToken === "string" &&
      (!refreshToken.trim() || refreshToken.length > MAX_TOKEN_LENGTH)
    ) {
      throw new VaultValidationError(
        `accounts[${index}].tokens.refreshToken must be a non-empty string of at most ${MAX_TOKEN_LENGTH} characters`,
      );
    }

    const credentialKindValue =
      candidate.credentialKind === undefined
        ? refreshToken === null
          ? "long_lived"
          : "rotating"
        : candidate.credentialKind;
    if (
      credentialKindValue !== "long_lived" &&
      credentialKindValue !== "rotating" &&
      credentialKindValue !== "managed"
    ) {
      throw new VaultValidationError(
        `accounts[${index}].credentialKind must be "long_lived", "rotating", or "managed" when present`,
      );
    }
    const credentialKind: AccountCredentialKind = credentialKindValue;
    if (credentialKind === "long_lived" && refreshToken !== null) {
      throw new VaultValidationError(
        `accounts[${index}].credentialKind "long_lived" requires a null refresh token`,
      );
    }
    if ((credentialKind === "rotating" || credentialKind === "managed") && refreshToken === null) {
      throw new VaultValidationError(
        `accounts[${index}].credentialKind "${credentialKind}" requires a refresh token`,
      );
    }

    // Provider discriminator. Absent ≡ "anthropic"; only non-default ids are stored, so Anthropic
    // records round-trip byte-identically (and pre-provider vaults keep validating unchanged).
    const providerValue = candidate.provider;
    if (providerValue !== undefined && providerValue !== "anthropic" && providerValue !== "openai") {
      throw new VaultValidationError(
        `accounts[${index}].provider must be "anthropic" or "openai" when present`,
      );
    }
    const provider: ProviderId | undefined = providerValue === "openai" ? "openai" : undefined;

    let sub2api: StoredAccount["sub2api"];
    if (candidate.sub2api !== undefined) {
      const source = candidate.sub2api;
      if (!record(source) || !validSub2ApiAccountId(source.accountId) || credentialKind !== "long_lived" || refreshToken !== null) {
        throw new VaultValidationError(`accounts[${index}].sub2api must identify an externally managed account`);
      }
      try {
        sub2api = { baseUrl: normalizeSub2ApiUrl(source.baseUrl), accountId: source.accountId };
      } catch {
        throw new VaultValidationError(`accounts[${index}].sub2api.baseUrl must be a valid HTTP(S) URL`);
      }
    }

    const fullName = optionalBoundedString(candidate.fullName, "fullName", index);
    const label = optionalBoundedString(candidate.label, "label", index);

    return {
      id: requiredString(candidate.id, "id", index, { nonEmpty: true, maxLength: MAX_ACCOUNT_ID_LENGTH }),
      email: requiredString(candidate.email, "email", index, { nonEmpty: true, maxLength: MAX_EMAIL_LENGTH }),
      ...(fullName !== undefined ? { fullName } : {}),
      ...(label !== undefined ? { label } : {}),
      plan: requiredString(candidate.plan, "plan", index, { nonEmpty: true, maxLength: MAX_PLAN_LENGTH }),
      addedAt,
      credentialKind,
      ...(provider ? { provider } : {}),
      ...(sub2api ? { sub2api } : {}),
      tokens: {
        accessToken: requiredString(candidate.tokens.accessToken, "tokens.accessToken", index, {
          nonEmpty: true,
          maxLength: MAX_TOKEN_LENGTH,
        }),
        refreshToken,
        expiresAt,
      },
    };
  });

  const ids = new Set<string>();
  for (const [index, account] of accounts.entries()) {
    if (ids.has(account.id)) {
      throw new VaultValidationError(`accounts[${index}].id duplicates another saved account`);
    }
    ids.add(account.id);
  }
  return accounts;
}

// Opaque optimistic-concurrency token for the decrypted logical vault. It intentionally changes
// whenever any stored field (including a rotated Claude credential) changes, but is stable across
// AES-GCM rewrites of identical data. Clients must present the revision they read before replacing a
// whole-vault snapshot; a stale browser can therefore never put an older refresh token back.
export function vaultRevision(accounts: readonly StoredAccount[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(accounts)).digest("hex");
}

interface ParsedVaultState {
  raw: string | null;
  accounts: StoredAccount[];
  encryptionSecretUsed: string | null;
}

function parseRawAccountsState(raw: string | null): ParsedVaultState {
  if (raw === null) return { raw, accounts: [], encryptionSecretUsed: null };
  if (typeof raw !== "string") throw new Error("Saved accounts vault returned an invalid storage value");
  try {
    const decrypted = decryptWithSecret(raw);
    const parsed = JSON.parse(decrypted.plaintext);
    return { raw, accounts: parseStoredAccounts(parsed), encryptionSecretUsed: decrypted.secret };
  } catch (err) {
    const detail = err instanceof VaultValidationError ? err.message : "decryption or JSON parsing failed";
    throw new Error(`Saved accounts vault is corrupt or uses the wrong encryption secret: ${detail}`);
  }
}

function parseRawAccounts(raw: string | null): StoredAccount[] {
  return parseRawAccountsState(raw).accounts;
}

async function encryptionSecretForNewVault(userId: string): Promise<string> {
  const storedProof = await readStoredKeyProof(userId);
  if (storedProof !== null) {
    const matching = decryptionCandidates().find((candidate) => keyProof(candidate) === storedProof);
    if (!matching) throw new VaultEncryptionKeyMismatchError();
    return matching;
  }

  const storage = storageSelection();
  // Convex's access secret is required by and stored with the backend deployment, so it is the one
  // server-proven bootstrap key every fresh instance shares. A preferred override is honored only
  // after a proof exists; otherwise two rolling deployments could create the first generation with
  // different values before either can read the other's ciphertext.
  if (storage.type === "convex") return storage.config.secret;
  if (storage.type === "redis") {
    const stable = env("VAULT_ENCRYPTION_SECRET");
    if (!stable) {
      throw new StorageConfigurationError(
        "Redis vault storage requires VAULT_ENCRYPTION_SECRET before the first account can be saved",
      );
    }
    return stable;
  }
  return encryptionSecret();
}

async function ensureRemoteGenerationGuarded(userId: string, state: ParsedVaultState): Promise<boolean> {
  if (storageBackend() === "file" || state.raw === null || !state.encryptionSecretUsed) return true;
  const proof = keyProof(state.encryptionSecretUsed);
  const storedProof = await readStoredKeyProof(userId);
  if (storedProof !== null) {
    if (storedProof !== proof) throw new VaultEncryptionKeyMismatchError();
    return true;
  }
  // Establish the tenant proof and mirror the already-validated current generation before any
  // caller can spend a refresh token. This also closes the rolling-deployment window: once a new app
  // instance reads the vault, legacy main/journal writers are fenced by the Convex functions.
  return compareAndSetRaw(userId, state.raw, state.raw, proof);
}

// A successful write snapshots the previous ciphertext first. If a later read finds a corrupt or
// wrong-key main value, restore that exact last-known-good generation with a fenced CAS and leave
// the backup untouched. Nothing ever turns an unreadable vault into an empty account list.
async function readParsedAccounts(
  userId: string,
  options: { localLockHeld?: boolean } = {},
): Promise<ParsedVaultState> {
  let lastRaceError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const mainRaw = await readRaw(userId);
    let mainError: Error | null = null;
    if (mainRaw !== null) {
      try {
        const parsed = parseRawAccountsState(mainRaw);
        if (await ensureRemoteGenerationGuarded(userId, parsed)) return parsed;
        lastRaceError = new Error("Saved accounts changed while their encryption guard was being established");
        continue;
      } catch (error) {
        mainError = error instanceof Error ? error : new Error("Saved accounts vault is unreadable");
      }
    }

    const backupRaw = await readBackupRaw(userId);
    if (backupRaw === null) {
      if (mainError) throw mainError;
      return { raw: null, accounts: [], encryptionSecretUsed: null };
    }

    let backup: ParsedVaultState;
    try {
      backup = parseRawAccountsState(backupRaw);
    } catch (error) {
      if (mainError) throw mainError;
      throw error;
    }
    if (!backup.encryptionSecretUsed) throw new Error("Saved accounts backup has no encryption key");

    const restored = await restoreBackupRaw(
      userId,
      mainRaw,
      backupRaw,
      keyProof(backup.encryptionSecretUsed),
      options.localLockHeld ?? false,
    );
    if (restored) return backup;
    lastRaceError = new Error("Saved accounts changed while the last-known-good backup was being restored");
  }
  throw lastRaceError ?? new Error("Couldn't restore the last-known-good saved accounts");
}

async function loadAccountsUnserialized(userId: string): Promise<StoredAccount[]> {
  return (await readParsedAccounts(userId)).accounts;
}

function serializeForUser<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(userId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(userId, settled);
  return result.finally(() => {
    if (mutationQueues.get(userId) === settled) mutationQueues.delete(userId);
  });
}

export async function loadAccounts(userId: string): Promise<StoredAccount[]> {
  return loadAccountsUnserialized(userId);
}

export async function saveAccounts(userId: string, accounts: StoredAccount[]): Promise<void> {
  // Snapshot and validate before the operation waits in the queue, so later caller mutation cannot
  // alter what ultimately gets persisted. Use the same CAS mutation path as targeted server-side
  // updates so even this administrative whole-vault replacement cannot clobber another instance.
  const safeAccounts = parseStoredAccounts(accounts);
  await mutateAccounts(userId, () => safeAccounts);
}

// Atomically mutate one tenant's whole-array vault. The per-process queue avoids needless local
// contention; remote backends additionally use compare-and-set so read/modify/write calls from
// different app instances cannot silently overwrite each other. A mutator can be invoked again after
// a CAS conflict, so callbacks must be deterministic/idempotent with respect to the supplied array.
// Returning the exact input array is an explicit no-op and avoids rewriting the ciphertext.
export async function mutateAccounts(
  userId: string,
  mutate: (
    accounts: readonly StoredAccount[],
  ) => readonly StoredAccount[] | Promise<readonly StoredAccount[]>,
): Promise<StoredAccount[]> {
  return serializeForUser(userId, async () => {
    const remote = storageBackend() !== "file";
    const operation = async (localLockHeld = false) => {
      const maxAttempts = remote ? 12 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const state = await readParsedAccounts(userId, { localLockHeld });
        const current = state.accounts;
        const candidate = await mutate(current);
        if (candidate === current) return current;
        const safeAccounts = parseStoredAccounts(candidate);
        // Remote ciphertext is shared by many processes and must remain on the exact key that read
        // its current generation. Local file mode is single-machine and may retain the historical
        // convenience migration to a newly configured stable key under its cross-process lock.
        const writeSecret = remote
          ? state.encryptionSecretUsed ?? (await encryptionSecretForNewVault(userId))
          : encryptionSecret();
        const saved = await compareAndSetRaw(
          userId,
          state.raw,
          encrypt(JSON.stringify(safeAccounts), writeSecret),
          keyProof(writeSecret),
        );
        if (saved) return safeAccounts;

        // Another instance won the CAS. Reload, re-run the transformation against its result, and
        // add a small bounded jitter so a burst of serverless workers does not remain in lockstep.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(5 * (attempt + 1), 40) + Math.floor(Math.random() * 5)),
        );
      }
      throw new Error("Vault changed repeatedly while saving; retry the operation.");
    };

    // Atomic rename protects readers from torn files; this portable mkdir lock additionally keeps
    // read/transform/write mutations atomic across multiple local Node processes.
    return remote ? operation() : withLocalVaultMutationLock(userId, () => operation(true));
  });
}
