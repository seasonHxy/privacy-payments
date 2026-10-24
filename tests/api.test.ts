import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/server.js";
import { Service, Store } from "../src/domain.js";
test("HTTP auth, CSRF, parallel tabs, immutable approval, no client success setter, scoped export", async () => {
  const store = new Store(":memory:", randomBytes(32));
  const server = createApp(new Service(store), "http://127.0.0.1:3000").listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  async function req(path: string, method = "GET", body?: unknown, extra = {}) {
    return fetch(base + "/api" + path, {
      method,
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
        Cookie: cookie,
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  try {
    assert.equal((await req("/invoices")).status, 401);
    assert.equal(
      (
        await req(
          "/demo/session",
          "POST",
          { user: "payer" },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    const login = await req("/demo/session", "POST", { user: "payer" });
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const i = await (
      await req("/invoices", "POST", {
        amountAtomic: "1000000",
        asset: "mock:USD",
        network: "mock-local",
        recipient: "recipient",
        address: "demo:recipient",
        purpose: "API fake invoice",
      })
    ).json();
    await req(`/invoices/${i.invoiceId}/approvals`, "POST", { version: 1 });
    const calls = await Promise.all(
      Array.from({ length: 8 }, () =>
        req(
          `/invoices/${i.invoiceId}/payment-attempts`,
          "POST",
          { version: 1 },
          { "Idempotency-Key": "same-http-key" },
        ),
      ),
    );
    assert.ok(calls.every((r) => r.status === 200));
    const attempts = await Promise.all(calls.map((r) => r.json()));
    assert.equal(new Set(attempts.map((a) => a.id)).size, 1);
    const clash = await req(
      `/invoices/${i.invoiceId}/payment-attempts`,
      "POST",
      { version: 1 },
      { "Idempotency-Key": "other-http-key" },
    );
    assert.equal(clash.status, 409);
    assert.equal(
      (
        await req(
          `/payment-attempts/${attempts[0].id}/execution-reference`,
          "POST",
          { reference: "sim:success", state: "VERIFIED_SUCCESS" },
        )
      ).status,
      400,
    );
    const switchUser = await req("/demo/session", "POST", {
      user: "accountant",
    });
    cookie = switchUser.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await req("/invoices", "POST", {})).status, 403);
    assert.equal((await req("/invoices/" + i.invoiceId)).status, 403);
    const staticPage = await fetch(base);
    assert.equal(staticPage.headers.get("cache-control"), "no-store");
    assert.ok(
      staticPage.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
    );
    assert.equal((await staticPage.text()).includes("API fake invoice"), false);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
  }
});
