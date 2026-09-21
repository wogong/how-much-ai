import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { AnthropicError } from "@/lib/anthropic";
import { parseCredentials } from "@/lib/credentials";
import { readLocalCredentialRaw, LocalCredentialError, localConnectAvailable } from "@/lib/local-credentials";
import {
  resolveAccount,
  saveResolvedAccount,
  resolveProviderAccount,
  saveProviderAccount,
} from "@/lib/connect-account";
import { getProvider, ProviderError } from "@/lib/providers/index";
import { browserMutationFailure, readJsonObject, requestBodyFailure } from "@/lib/request-body";

// Node runtime: reads the local machine (child_process / fs) and decrypts the vault (node:crypto).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Feature-detect for the UI: 200 { available: true } only when local; 404 otherwise.
export async function GET(req: Request) {
  if (!localConnectAvailable()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const userId = await requireUser(req);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ available: true });
}

// Read THIS machine's Claude Code credential, resolve the account, and add it to the current user's
// vault. Returns display info only — NEVER the token.
export async function POST(req: Request) {
  if (!localConnectAvailable()) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
  if (
    body.expectedAccountId !== undefined &&
    (typeof body.expectedAccountId !== "string" ||
      !body.expectedAccountId.trim() ||
      body.expectedAccountId.length > 200)
  ) {
    return NextResponse.json({ error: "Invalid expected account id" }, { status: 400 });
  }
  const expectedAccountId =
    typeof body.expectedAccountId === "string" ? body.expectedAccountId.trim() : undefined;

  if (body.provider !== undefined && body.provider !== "anthropic" && body.provider !== "openai") {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }
  const provider = body.provider === "openai" ? "openai" : "anthropic";

  // OpenAI (ChatGPT/Codex): one-click read of this machine's ~/.codex/auth.json, then resolve + save.
  if (provider === "openai") {
    try {
      const oai = getProvider("openai");
      if (!oai.readLocalCredential) {
        return NextResponse.json({ error: "Local ChatGPT connect is unavailable." }, { status: 404 });
      }
      const tokens = await oai.readLocalCredential();
      const { identity } = await resolveProviderAccount(tokens, "openai");
      if (expectedAccountId && identity.id !== expectedAccountId) {
        return NextResponse.json(
          {
            error: `This machine is signed into ${identity.email}.`,
            recommendation: "Sign the Codex CLI into the account named in the reconnect dialog, then try again.",
          },
          { status: 409 },
        );
      }
      const info = await saveProviderAccount(userId, identity, tokens, "openai");
      return NextResponse.json({
        id: info.id,
        email: info.email,
        plan: info.plan,
        label: info.label,
        alreadyConnected: info.alreadyConnected,
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        const status = [400, 401, 403, 404, 409, 422, 429].includes(err.status) ? err.status : 502;
        return NextResponse.json(
          {
            error: err.message,
            recommendation: "Sign in with the Codex CLI (`codex login`), or paste your ~/.codex/auth.json instead.",
          },
          { status },
        );
      }
      return NextResponse.json(
        { error: "Couldn't connect this ChatGPT account.", recommendation: "Try again, or paste your ~/.codex/auth.json." },
        { status: 502 },
      );
    }
  }

  // 1) Read the local credential (macOS Keychain via execFile, else ~/.claude/.credentials.json).
  let raw: string;
  try {
    raw = await readLocalCredentialRaw();
  } catch (err) {
    if (err instanceof LocalCredentialError) {
      return NextResponse.json({ error: err.message, recommendation: err.recommendation }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: "Couldn't read the local Claude Code credential.",
        recommendation: "Add the account by pasting its token instead.",
      },
      { status: 500 },
    );
  }

  const parsed = parseCredentials(raw);
  if (!parsed) {
    return NextResponse.json(
      {
        error: "The local Claude Code credential wasn't in a recognized format.",
        recommendation: "Sign in to Claude Code again, or add the account by pasting its token.",
      },
      { status: 422 },
    );
  }

  // 2) Resolve identity via fetchProfile + add to the vault (dedupe by account id).
  try {
    const resolved = await resolveAccount(parsed.tokens);
    const resolvedId = resolved.profile?.account?.uuid;
    if (expectedAccountId && resolvedId !== expectedAccountId) {
      return NextResponse.json(
        {
          error: `This machine is signed into ${resolved.profile?.account?.email ?? "a different Claude account"}.`,
          recommendation: "Sign Claude Code into the account named in the reconnect dialog, then try again.",
        },
        { status: 409 },
      );
    }
    const info = await saveResolvedAccount(userId, resolved.profile, resolved.tokens);
    return NextResponse.json({
      id: info.id,
      email: info.email,
      plan: info.plan,
      label: info.label,
      alreadyConnected: info.alreadyConnected,
    });
  } catch (err) {
    if (err instanceof AnthropicError) {
      const status = err.status === 429 ? 429 : err.status >= 400 && err.status < 500 ? 401 : 502;
      return NextResponse.json(
        {
          error: err.message,
          recommendation: "This account may need a fresh sign-in in Claude Code — or add it by pasting its token.",
        },
        { status },
      );
    }
    return NextResponse.json(
      { error: "Couldn't connect this account.", recommendation: "Try again, or add it by pasting its token." },
      { status: 502 },
    );
  }
}
