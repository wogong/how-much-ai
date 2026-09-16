// Shared by the connection boundary and vault parser. Private hosts are intentional: sub2api
// commonly runs on the same machine or LAN. Redirects are separately disabled by the HTTP client.
export function normalizeSub2ApiUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid sub2api URL.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter the full http:// or https:// sub2api URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) sub2api URL without credentials, query, or fragment.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "")}`;
}

export function validSub2ApiAccountId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
