// Client-side presentation metadata for providers. The client can't import the server provider
// registry (it pulls in Node built-ins), so the display label + icon + connect capabilities live here.
import type { ReactElement } from "react";
import type { ProviderId } from "@/lib/providers/types";
import { AnthropicIcon, OpenAIIcon } from "./Icons";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  Icon: (props: { className?: string }) => ReactElement;
  supportsOAuth: boolean;
  // The CLI whose rotating login the quick-connect methods copy, phrased for possessive use
  // ("<cliLabel>'s rotating login"). Only providers with a shared CLI credential need it.
  cliLabel: string;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Claude",
    Icon: AnthropicIcon,
    supportsOAuth: true,
    cliLabel: "Claude Code",
  },
  openai: {
    id: "openai",
    label: "ChatGPT",
    Icon: OpenAIIcon,
    supportsOAuth: false,
    cliLabel: "the Codex CLI",
  },
};

// Picker order (matches lib/providers PROVIDERS).
export const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai"];

export function providerMeta(id: ProviderId | undefined): ProviderMeta {
  return PROVIDER_META[id ?? "anthropic"] ?? PROVIDER_META.anthropic;
}

export interface ParsedCredentialTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

// Browser-safe decode of an access token's `exp` claim (epoch ms), or 0. Identity only — never trusted.
function jwtExpiryMs(token: string): number {
  try {
    const seg = token.split(".")[1];
    if (!seg) return 0;
    let b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    return typeof payload.exp === "number" && payload.exp > 0 ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Parse a pasted ~/.codex/auth.json (or a bare tokens object) client-side into vault tokens. Mirrors
// the server-side extractOpenAITokens; kept here so the Connect dialog never imports Node-only code.
export function parseCodexCredential(text: string): ParsedCredentialTokens | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const root = obj as Record<string, unknown>;
  const tokens = (root.tokens && typeof root.tokens === "object" ? root.tokens : root) as Record<string, unknown>;
  const accessToken = tokens.access_token ?? tokens.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const refreshRaw = tokens.refresh_token ?? tokens.refreshToken;
  const exp = jwtExpiryMs(accessToken);
  return {
    accessToken,
    refreshToken: typeof refreshRaw === "string" && refreshRaw ? refreshRaw : null,
    expiresAt: exp > 0 ? exp : Date.now() + 10 * 24 * 60 * 60 * 1000,
  };
}
