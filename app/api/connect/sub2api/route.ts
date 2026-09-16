import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";
import { normalizeSub2ApiUrl, validSub2ApiAccountId } from "@/lib/sub2api-config";
import { connectAllSub2ApiAccounts, connectSub2ApiAccount, listSub2ApiAccounts, Sub2ApiError } from "@/lib/sub2api";
import { persistStoredAccount } from "@/lib/connect-account";
import { loadAccounts, mutateAccounts } from "@/lib/vault";
import { clearAccountUsageState } from "@/lib/usage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST keeps the admin key out of URLs, access logs, and browser history. Outbound calls are GETs.
export async function POST(req: Request) {
  const guard = browserMutationFailure(req);
  if (guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    const failure = requestBodyFailure(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeSub2ApiUrl(body.baseUrl);
  } catch {
    return NextResponse.json({ error: "Enter an HTTP(S) sub2api URL without credentials, query, or fragment." }, { status: 400 });
  }
  if (typeof body.adminKey !== "string" || !body.adminKey.trim() || body.adminKey.length > 16 * 1024 || /[\r\n]/.test(body.adminKey)) {
    return NextResponse.json({ error: "An Admin API Key is required." }, { status: 400 });
  }
  const adminKey = body.adminKey.trim();
  try {
    if (body.action === "list") {
      const page = body.page ?? 1;
      if (!Number.isSafeInteger(page) || (page as number) < 1 || (page as number) > 10000 || (body.provider !== undefined && body.provider !== "anthropic" && body.provider !== "openai")) {
        return NextResponse.json({ error: "Invalid provider or page." }, { status: 400 });
      }
      return NextResponse.json(await listSub2ApiAccounts(baseUrl, adminKey, page as number, body.provider), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (body.action === "connect_all") {
      if (body.expectedAccountId !== undefined) {
        return NextResponse.json({ error: "Reconnect one account using its existing identity." }, { status: 400 });
      }
      await loadAccounts(userId);
      const accounts = await connectAllSub2ApiAccounts(baseUrl, adminKey);
      if (!accounts.length) return NextResponse.json({ error: "No supported Claude or ChatGPT subscription accounts were found." }, { status: 422 });
      await mutateAccounts(userId, existing => {
        const incoming = new Map(accounts.map(account => [account.id, account]));
        const next = existing.map(account => {
          const replacement = incoming.get(account.id);
          incoming.delete(account.id);
          return replacement ? { ...replacement, label: account.label, addedAt: account.addedAt } : account;
        });
        next.push(...incoming.values());
        if (next.length > 500) throw new Sub2ApiError("Connecting these accounts would exceed the dashboard's 500-account limit.", 422);
        return next;
      });
      await Promise.all(accounts.map(account => clearAccountUsageState(userId, account.id).catch(() => {})));
      return NextResponse.json({ ok: true, count: accounts.length, email: `${accounts.length} sub2api accounts`, label: `${accounts.length} sub2api accounts` }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (body.action !== "connect" || !validSub2ApiAccountId(body.accountId)) {
      return NextResponse.json({ error: "Choose a supported sub2api account." }, { status: 400 });
    }
    // Validate vault readability before fetching any upstream metadata or attempting persistence.
    const existing = await loadAccounts(userId);
    if (body.expectedAccountId !== undefined && (typeof body.expectedAccountId !== "string" || !existing.some(a => a.id === body.expectedAccountId && a.sub2api))) {
      return NextResponse.json({ error: "The sub2api account to reconnect was not found." }, { status: 409 });
    }
    const account = await connectSub2ApiAccount(baseUrl, adminKey, body.accountId);
    if (body.expectedAccountId !== undefined && account.id !== body.expectedAccountId) {
      return NextResponse.json({ error: "Select the same sub2api instance and account to reconnect." }, { status: 409 });
    }
    const info = await persistStoredAccount(userId, account);
    return NextResponse.json({ ok: true, ...info }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Sub2ApiError) {
      const status = [401, 403, 404, 422, 429].includes(error.status) ? error.status : 502;
      return NextResponse.json({ error: error.message }, { status });
    }
    // Do not report arbitrary response/parser errors that may contain the remote admin key.
    return NextResponse.json({ error: "Couldn't connect sub2api or save its encrypted credential. Check the instance and vault configuration." }, { status: 500 });
  }
}
