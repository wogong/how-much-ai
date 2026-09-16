import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { toBrowserUsageResponse } from "@/lib/browser-boundary";
import { getAccountUsage } from "@/lib/usage-service";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import type { StoredAccount } from "@/lib/types";

// Node runtime: the coordinated path decrypts the vault (node:crypto) to read/persist tokens.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The dashboard's coordinated per-account refresh. The browser supplies only an account id; the
// encrypted server vault is the sole credential authority. A shared cache and owner-fenced lease
// prevent dashboard, cron, and parallel app instances from spending one rotating token twice.
// New credentials use /api/connect/manual, which verifies and durably saves before success.
export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req, 4 * 1024);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }

  // Dashboard refresh: accept an account id and optional active-refresh flag. Ignoring any posted token fields closes stale-tab
  // and forged-expiry paths; getAccountUsage loads the current encrypted vault record itself.
  if (typeof body.accountId !== "string" || !body.accountId.trim() || body.accountId.length > 200) {
    return NextResponse.json({ error: "Invalid or missing account id" }, { status: 400 });
  }
  if (body.activeRefresh !== undefined && typeof body.activeRefresh !== "boolean") {
    return NextResponse.json({ error: "activeRefresh must be a boolean" }, { status: 400 });
  }
  const account = {
    id: body.accountId.trim(),
    tokens: { accessToken: "", refreshToken: null, expiresAt: 0 },
  } as StoredAccount;
  const result = await getAccountUsage(userId, account, { activeRefresh: body.activeRefresh === true });
  // Token rotation and recovery are wholly server-side. Even the exceptional journal-recovery path
  // is allowlisted through this serializer, so browser responses never contain either credential.
  return NextResponse.json(toBrowserUsageResponse(result));
}
