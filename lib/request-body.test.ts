import { test } from "node:test";
import assert from "node:assert/strict";
import { browserMutationFailure, readJsonObject, RequestBodyError } from "./request-body.ts";

function post(body: string, headers?: HeadersInit): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

test("bounded JSON reader returns only object-shaped bodies", async () => {
  assert.deepEqual(await readJsonObject(post('{"accountId":"account-1"}')), { accountId: "account-1" });

  for (const primitive of ["null", "[]", '"string"', "42", "true"]) {
    await assert.rejects(
      () => readJsonObject(post(primitive)),
      (error: unknown) => error instanceof RequestBodyError && error.status === 400,
    );
  }
});

test("bounded JSON reader requires an actual JSON media type", async () => {
  await assert.rejects(
    () => readJsonObject(post("{}", { "Content-Type": "text/plain" })),
    (error: unknown) => error instanceof RequestBodyError && error.status === 415,
  );
  assert.deepEqual(
    await readJsonObject(post('{"ok":true}', { "Content-Type": "application/problem+json; charset=utf-8" })),
    { ok: true },
  );
});

test("browser mutation guard rejects explicit and Fetch-Metadata cross-origin requests", () => {
  assert.deepEqual(
    browserMutationFailure(
      new Request("http://localhost/api/test", { headers: { Origin: "https://attacker.example" } }),
    ),
    { error: "Cross-origin request is not allowed", status: 403 },
  );
  assert.deepEqual(
    browserMutationFailure(
      new Request("http://localhost/api/test", { headers: { "Sec-Fetch-Site": "cross-site" } }),
    ),
    { error: "Cross-origin request is not allowed", status: 403 },
  );
  assert.equal(
    browserMutationFailure(
      new Request("http://localhost/api/test", {
        headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      }),
    ),
    null,
  );
  assert.equal(browserMutationFailure(new Request("http://localhost/api/test")), null);
});

test("browser mutation guard accepts the configured public origin behind a proxy", () => {
  const previous = process.env.APP_URL;
  const proxied = (origin: string) =>
    new Request("http://127.0.0.1:3001/api/test", { headers: { Origin: origin } });
  try {
    process.env.APP_URL = "https://dashboard.example";
    assert.equal(browserMutationFailure(proxied("https://dashboard.example")), null);
    assert.deepEqual(browserMutationFailure(proxied("https://attacker.example")), {
      error: "Cross-origin request is not allowed",
      status: 403,
    });
    assert.equal(browserMutationFailure(proxied("http://127.0.0.1:3001")), null);

    process.env.APP_EXTRA_ORIGINS = " https://public.example/, not-a-url ,http://lan.example:3301";
    assert.equal(browserMutationFailure(proxied("https://public.example")), null);
    assert.equal(browserMutationFailure(proxied("http://lan.example:3301")), null);
    assert.equal(browserMutationFailure(proxied("https://dashboard.example")), null);
    assert.deepEqual(browserMutationFailure(proxied("https://attacker.example")), {
      error: "Cross-origin request is not allowed",
      status: 403,
    });
    delete process.env.APP_EXTRA_ORIGINS;

    process.env.APP_URL = "not-a-url";
    assert.deepEqual(browserMutationFailure(proxied("https://dashboard.example")), {
      error: "Cross-origin request is not allowed",
      status: 403,
    });
  } finally {
    if (previous === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previous;
  }
});

test("bounded JSON reader rejects malformed and missing bodies as 400", async () => {
  await assert.rejects(() => readJsonObject(post("{")), /Invalid JSON body/);
  await assert.rejects(
    () => readJsonObject(new Request("http://localhost/test", { method: "POST" })),
    (error: unknown) => error instanceof RequestBodyError && error.status === 400,
  );
});

test("declared and streamed body sizes are capped in bytes with 413", async () => {
  await assert.rejects(
    () => readJsonObject(post("{}", { "Content-Length": "999" }), 32),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );

  const multibyte = JSON.stringify({ value: "😀😀😀😀" });
  assert.ok(new TextEncoder().encode(multibyte).byteLength > 16);
  await assert.rejects(
    () => readJsonObject(post(multibyte), 16),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  );
});
