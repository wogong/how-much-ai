import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { toBrowserAccounts } from "@/lib/browser-boundary";
import {
  loadAccounts,
  mutateAccounts,
  VaultEncryptionKeyMismatchError,
  vaultRevision,
} from "@/lib/vault";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { reportServerError } from "@/lib/server-error-diagnostics";
import { syncSub2ApiAccounts } from "@/lib/sub2api";
import type { StoredAccount, VaultMutation } from "@/lib/types";

// Force the Node runtime — the vault uses node:crypto to decrypt.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MUTATIONS = 100;
const MAX_ACCOUNT_ID_LENGTH = 200;
const MAX_EMAIL_LENGTH = 512;
const MAX_DISPLAY_FIELD_LENGTH = 1_000;
const MAX_PLAN_LENGTH = 200;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  options: { nullable?: boolean; nonEmpty?: boolean } = {},
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && options.nullable) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string${options.nullable ? " or null" : ""}`);
  if (options.nonEmpty && !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value;
}

function parseMutations(value: unknown): VaultMutation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("mutations must be a non-empty array");
  if (value.length > MAX_MUTATIONS) throw new Error(`mutations must contain at most ${MAX_MUTATIONS} entries`);

  return value.map((candidate, index) => {
    if (!record(candidate)) throw new Error(`mutations[${index}] must be an object`);
    const accountId = requiredString(candidate.accountId, `mutations[${index}].accountId`, MAX_ACCOUNT_ID_LENGTH);

    if (candidate.op === "remove") {
      if (!hasOnlyKeys(candidate, ["op", "accountId"])) throw new Error(`mutations[${index}] contains unsupported fields`);
      return { op: "remove", accountId };
    }

    if (candidate.op === "rename") {
      if (!hasOnlyKeys(candidate, ["op", "accountId", "label"])) {
        throw new Error(`mutations[${index}] contains unsupported fields`);
      }
      const label = optionalString(candidate.label, `mutations[${index}].label`, MAX_DISPLAY_FIELD_LENGTH, {
        nullable: true,
      });
      if (label === undefined) throw new Error(`mutations[${index}].label is required`);
      return { op: "rename", accountId, label: label && label.trim() ? label.trim() : null };
    }

    if (candidate.op === "update_metadata") {
      if (!hasOnlyKeys(candidate, ["op", "accountId", "email", "fullName", "plan"])) {
        throw new Error(`mutations[${index}] contains unsupported fields`);
      }
      const email = optionalString(candidate.email, `mutations[${index}].email`, MAX_EMAIL_LENGTH, { nonEmpty: true });
      const fullName = optionalString(candidate.fullName, `mutations[${index}].fullName`, MAX_DISPLAY_FIELD_LENGTH, {
        nullable: true,
      });
      const plan = optionalString(candidate.plan, `mutations[${index}].plan`, MAX_PLAN_LENGTH, { nonEmpty: true });
      if (email === null || plan === null) throw new Error(`mutations[${index}] contains invalid metadata`);
      if (email === undefined && fullName === undefined && plan === undefined) {
        throw new Error(`mutations[${index}] must change at least one metadata field`);
      }
      return {
        op: "update_metadata",
        accountId,
        ...(email !== undefined ? { email } : {}),
        ...(fullName !== undefined ? { fullName } : {}),
        ...(plan !== undefined ? { plan } : {}),
      };
    }

    throw new Error(`mutations[${index}].op is invalid`);
  });
}

function applyMutations(current: readonly StoredAccount[], mutations: readonly VaultMutation[]): readonly StoredAccount[] {
  let next = [...current];
  let changed = false;

  for (const mutation of mutations) {
    const index = next.findIndex((account) => account.id === mutation.accountId);
    if (index < 0) continue;

    if (mutation.op === "remove") {
      next.splice(index, 1);
      changed = true;
      continue;
    }

    const account = next[index];
    if (mutation.op === "rename") {
      if ((account.label ?? null) === mutation.label) continue;
      const updated = { ...account };
      if (mutation.label === null) delete updated.label;
      else updated.label = mutation.label;
      next[index] = updated;
      changed = true;
      continue;
    }

    const updated = { ...account };
    let metadataChanged = false;
    if (mutation.email !== undefined && mutation.email !== account.email) {
      updated.email = mutation.email;
      metadataChanged = true;
    }
    if (mutation.fullName !== undefined && mutation.fullName !== (account.fullName ?? null)) {
      if (mutation.fullName === null) delete updated.fullName;
      else updated.fullName = mutation.fullName;
      metadataChanged = true;
    }
    if (mutation.plan !== undefined && mutation.plan !== account.plan) {
      updated.plan = mutation.plan;
      metadataChanged = true;
    }
    if (metadataChanged) {
      next[index] = updated;
      changed = true;
    }
  }

  return changed ? next : current;
}

function snapshotResponse(accounts: readonly StoredAccount[]) {
  return { accounts: toBrowserAccounts(accounts), revision: vaultRevision(accounts) };
}

function vaultErrorCode(error: unknown): "VAULT_UNREADABLE" | undefined {
  if (error instanceof VaultEncryptionKeyMismatchError) return "VAULT_UNREADABLE";
  if (
    error instanceof Error &&
    error.message.startsWith("Saved accounts vault is corrupt or uses the wrong encryption secret:")
  ) {
    return "VAULT_UNREADABLE";
  }
  return undefined;
}

export async function GET(req: Request) {
  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  try {
    // Pick up accounts added in sub2api since connection. A sync failure must never hide the vault.
    await syncSub2ApiAccounts(userId).catch(() => {});
    const accounts = await loadAccounts(userId);
    return NextResponse.json(snapshotResponse(accounts));
  } catch (err) {
    const { errorId } = reportServerError("vault.read", err);
    const errorCode = vaultErrorCode(err);
    return NextResponse.json(
      {
        error: "Couldn't read saved accounts",
        errorId,
        ...(errorCode ? { errorCode } : {}),
      },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 32 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }

  if (body.revision === undefined) {
    return NextResponse.json(
      { error: "A vault revision is required. Reload saved accounts before saving." },
      { status: 428 },
    );
  }
  if (typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
    return NextResponse.json({ error: "Invalid vault revision" }, { status: 400 });
  }

  let mutations: VaultMutation[];
  try {
    mutations = parseMutations(body.mutations);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid vault mutations" },
      { status: 400 },
    );
  }

  let conflict: StoredAccount[] | null = null;
  try {
    const saved = await mutateAccounts(userId, (current) => {
      // Credentials are included in the opaque revision but never in the request. A token rotation
      // therefore forces a redacted 409, after which the browser can replay only this semantic edit.
      if (vaultRevision(current) !== body.revision) {
        conflict = [...current];
        return current;
      }
      return applyMutations(current, mutations);
    });
    if (conflict) {
      return NextResponse.json(
        {
          error: "Saved accounts changed since this page loaded. Retry the edit against the latest revision.",
          ...snapshotResponse(conflict),
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, ...snapshotResponse(saved) });
  } catch (err) {
    const { errorId } = reportServerError("vault.mutate", err);
    const errorCode = vaultErrorCode(err);
    return NextResponse.json(
      {
        error: "Couldn't save account changes",
        errorId,
        ...(errorCode ? { errorCode } : {}),
      },
      { status: 500 },
    );
  }
}
