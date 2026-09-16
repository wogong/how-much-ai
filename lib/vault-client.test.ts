import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { BrowserAccount, VaultMutation } from "./types.ts";

const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./error-reference") return nextResolve("./error-reference.ts", context);
    return nextResolve(specifier, context);
  },
});
const {
  archiveUnreadableVault,
  fetchVault,
  persistVaultMutations,
  saveVaultMutations,
  VaultRequestError,
} = await import("./vault-client.ts");
moduleHooks.deregister();

function account(id: string, overrides: Partial<BrowserAccount> = {}): BrowserAccount {
  return {
    id,
    email: `${id}@example.com`,
    fullName: `Person ${id}`,
    plan: "Pro",
    addedAt: 1_700_000_000_000,
    credentialKind: "managed",
    credentialExpiresAt: 1_800_000_000_000,
    ...overrides,
  };
}

test("vault client accepts redacted account DTOs and rejects credential-bearing snapshots", async () => {
  const originalFetch = globalThis.fetch;
  const revision = "d".repeat(64);
  const managed = account("managed-snapshot");
  try {
    globalThis.fetch = async () => Response.json({ accounts: [managed], revision });
    assert.deepEqual(await fetchVault(), { accounts: [managed], revision });

    const external = account("external-snapshot", { source: "sub2api", credentialKind: "long_lived", credentialExpiresAt: 0 });
    globalThis.fetch = async () => Response.json({ accounts: [external], revision });
    assert.deepEqual(await fetchVault(), { accounts: [external], revision });
    globalThis.fetch = async () => Response.json({ accounts: [{ ...external, source: "unexpected" }], revision });
    await assert.rejects(() => fetchVault(), /invalid synchronization revision/i);

    globalThis.fetch = async () =>
      Response.json({
        accounts: [
          {
            ...managed,
            tokens: { accessToken: "leaked-access", refreshToken: "leaked-refresh", expiresAt: 1 },
          },
        ],
        revision,
      });
    await assert.rejects(() => fetchVault(), /invalid synchronization revision/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault client preserves unreadable recovery metadata and shows a safe incident reference", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: "Couldn't read saved accounts",
        errorId: "err_0123456789ab",
        errorCode: "VAULT_UNREADABLE",
      },
      { status: 500 },
    );
  try {
    await assert.rejects(
      () => fetchVault(),
      (error: unknown) => {
        assert.ok(error instanceof VaultRequestError);
        assert.equal(error.errorId, "err_0123456789ab");
        assert.equal(error.errorCode, "VAULT_UNREADABLE");
        assert.equal(error.message, "Couldn't read saved accounts. Reference: err_0123456789ab.");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault client discards malformed error metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: "Couldn't save account changes",
        errorId: "err_0123456789ab\ncredential",
        errorCode: "VAULT_UNREADABLE<script>",
      },
      { status: 500 },
    );
  try {
    await assert.rejects(
      () => saveVaultMutations([{ op: "remove", accountId: "account-1" }], "a".repeat(64)),
      (error: unknown) => {
        assert.ok(error instanceof VaultRequestError);
        assert.equal(error.errorId, undefined);
        assert.equal(error.errorCode, undefined);
        assert.equal(error.message, "Couldn't save account changes");
        assert.equal(error.message.includes("credential"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault mutation requests contain only revisioned semantic fields", async () => {
  const originalFetch = globalThis.fetch;
  const revision = "a".repeat(64);
  const nextRevision = "b".repeat(64);
  let body: Record<string, unknown> | null = null;
  const mutation = {
    op: "rename",
    accountId: "account-1",
    label: "Primary",
    tokens: { accessToken: "must-not-post", refreshToken: "must-not-post-either" },
  } as VaultMutation & { tokens: { accessToken: string; refreshToken: string } };

  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ accounts: [account("account-1", { label: "Primary" })], revision: nextRevision });
  };

  try {
    await saveVaultMutations([mutation], revision);
    assert.deepEqual(body, {
      mutations: [{ op: "rename", accountId: "account-1", label: "Primary" }],
      revision,
    });
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("must-not-post"), false);
    assert.equal(serialized.includes("accessToken"), false);
    assert.equal(serialized.includes("refreshToken"), false);
    assert.equal(serialized.includes("accounts"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("semantic mutations rebase a redacted 409 and retry against its latest revision", async () => {
  const originalFetch = globalThis.fetch;
  const original = account("conflict");
  const latest = account("conflict", { credentialExpiresAt: original.credentialExpiresAt + 60_000 });
  const saved = { ...latest, label: "Primary" };
  const staleRevision = "a".repeat(64);
  const latestRevision = "b".repeat(64);
  const savedRevision = "c".repeat(64);
  const requests: Array<{ mutations: VaultMutation[]; revision: string }> = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { mutations: VaultMutation[]; revision: string };
    requests.push(body);
    if (requests.length === 1) {
      return Response.json(
        { error: "conflict", accounts: [latest], revision: latestRevision },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, accounts: [saved], revision: savedRevision });
  };

  try {
    const mutation: VaultMutation = { op: "rename", accountId: original.id, label: "Primary" };
    const result = await persistVaultMutations(
      { accounts: [original], revision: staleRevision },
      [mutation],
    );
    assert.deepEqual(requests, [
      { mutations: [mutation], revision: staleRevision },
      { mutations: [mutation], revision: latestRevision },
    ]);
    assert.deepEqual(result, { accounts: [saved], revision: savedRevision });
    const serialized = JSON.stringify({ requests, result });
    assert.equal(serialized.includes("accessToken"), false);
    assert.equal(serialized.includes("refreshToken"), false);
    assert.equal(serialized.includes("tokens"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("archiveUnreadableVault requires the explicit safe-recovery contract", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; method?: string; body?: string } | null = null;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), method: init?.method, body: String(init?.body) };
    return Response.json({ ok: true, archive: "vault.enc.unreadable-20260710T120000Z.bak" });
  };
  try {
    const recovery = await archiveUnreadableVault();
    assert.deepEqual(recovery, { archive: "vault.enc.unreadable-20260710T120000Z.bak" });
    assert.deepEqual(request, {
      url: "/api/vault/recover",
      method: "POST",
      body: JSON.stringify({ confirmation: "ARCHIVE_UNREADABLE_VAULT" }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("archiveUnreadableVault preserves both validated archive labels", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      ok: true,
      archive: "vault-unreadable-20260710T120000000Z-aabbccddeeff-0011223344556677.enc",
      backupArchive: "vault-unreadable-backup-20260710T120000000Z-112233445566-0011223344556677.enc",
    });
  try {
    assert.deepEqual(await archiveUnreadableVault(), {
      archive: "vault-unreadable-20260710T120000000Z-aabbccddeeff-0011223344556677.enc",
      backupArchive: "vault-unreadable-backup-20260710T120000000Z-112233445566-0011223344556677.enc",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("archiveUnreadableVault rejects unsafe primary or backup archive labels", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const response of [
      { ok: true, archive: "../vault.enc" },
      { ok: true, archive: "vault-unreadable.enc", backupArchive: "/private/backup.enc" },
      { ok: true, archive: "vault-unreadable.enc", backupArchive: "backup.enc\ncredential" },
    ]) {
      globalThis.fetch = async () => Response.json(response);
      await assert.rejects(() => archiveUnreadableVault(), /invalid recovery response/i);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("archiveUnreadableVault surfaces a server recovery refusal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: "The current vault is readable and was not archived." }, { status: 409 });
  try {
    await assert.rejects(() => archiveUnreadableVault(), /readable and was not archived/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
