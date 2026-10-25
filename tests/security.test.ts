import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Service, Store } from "../src/domain.js";
import { createApp } from "../src/server.js";
const payload = {
  amountAtomic: "100",
  asset: "mock:USD",
  network: "mock-local",
  recipient: "recipient",
  address: "demo:recipient",
  purpose: "SECRET_PURPOSE",
  attachment: {
    name: "fake.txt",
    type: "text/plain",
    content: "SECRET_ATTACHMENT",
  },
};

test("adversarial HTTP matrix: CSRF, viewer alternate paths, scoped conditional downloads, cross-invoice idempotency, expiry", async () => {
  let now = Date.now();
  const store = new Store(":memory:", randomBytes(32)),
    s = new Service(store, () => now);
  const i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  const a = s.start("payer", i.invoiceId, 1, "security-test-key");
  const q = s.quote("payer", a.id);
  const server = createApp(s).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  async function req(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    extra: Record<string, string> = {},
  ) {
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
  async function login(user: string) {
    return (await req("/demo/session", "POST", { user })).headers
      .get("set-cookie")!
      .split(";")[0]!;
  }
  try {
    const payer = await login("payer"),
      viewer = await login("accountant"),
      outside = await login("outsider");
    for (const origin of ["", "null", "https://evil.example"]) {
      assert.equal(
        (await req("/invoices", "POST", payload, payer, { Origin: origin }))
          .status,
        403,
      );
      assert.equal(
        (
          await req("/demo/session", "POST", { user: "payer" }, "", {
            Origin: origin,
          })
        ).status,
        403,
      );
    }
    const absentOrigin = await fetch(base + "/api/invoices", {
      method: "POST",
      headers: { Cookie: payer, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(absentOrigin.status, 403);
    assert.equal(
      (
        await req("/invoices", "POST", payload, payer, {
          "Content-Type": "text/plain",
        })
      ).status,
      415,
    );
    const before = s.status("payer", a.id).state;
    const paths: [string, string, unknown?][] = [
      ["/invoices/" + i.invoiceId, "GET"],
      [`/invoices/${i.invoiceId}/attachment?version=1`, "GET"],
      [`/invoices/${i.invoiceId}/approvals`, "POST", { version: 1 }],
      [`/invoices/${i.invoiceId}/payment-attempts`, "POST", { version: 1 }],
      [`/payment-attempts/${a.id}`, "GET"],
      ...["quote", "prepare-signing", "reject", "recheck"].map(
        (p) =>
          [`/payment-attempts/${a.id}/${p}`, "POST", {}] as [
            string,
            string,
            unknown,
          ],
      ),
      [
        `/payment-attempts/${a.id}/confirm`,
        "POST",
        { version: 1, quoteFingerprint: q.quote!.fingerprint },
      ],
      [
        `/payment-attempts/${a.id}/execution-reference`,
        "POST",
        { reference: "sim:success" },
      ],
    ];
    for (const [path, method, body] of paths) {
      const r = await req(path, method, body, viewer, {
        "Idempotency-Key": "viewer-test-key",
      });
      assert.equal(r.status, 403, path);
      const text = await r.text();
      assert.ok(!text.includes("SECRET_"));
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(s.status("payer", a.id).state, before);
    assert.deepEqual(
      await (await req("/invoices", "GET", undefined, viewer)).json(),
      [],
    );
    assert.equal(
      (await req("/invoices/" + i.invoiceId, "GET", undefined, outside)).status,
      404,
    );
    const attachment = await req(
      `/invoices/${i.invoiceId}/attachment?version=1`,
      "GET",
      undefined,
      payer,
    );
    assert.equal(attachment.status, 200);
    assert.equal(await attachment.text(), "SECRET_ATTACHMENT");
    assert.match(attachment.headers.get("content-disposition")!, /attachment/);
    assert.equal(attachment.headers.get("cache-control"), "no-store");
    const g = s.grant("payer", {
      invoiceId: i.invoiceId,
      version: 1,
      recipient: "accountant",
      fields: ["asset"],
      expiresAt: now + 1000,
    });
    const exportPath = `/disclosures/${g.id}/export`;
    const exported = await req(exportPath, "GET", undefined, viewer);
    const data = await exported.json();
    assert.deepEqual(
      Object.keys(data).sort(),
      ["asset", "invoiceId", "mode", "notice", "version"].sort(),
    );
    const etag = exported.headers.get("etag")!;
    s.revoke("payer", g.id);
    const revoked = await req(exportPath, "GET", undefined, viewer, {
      "If-None-Match": etag,
    });
    assert.equal(revoked.status, 403);
    assert.equal(revoked.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await req(
          `/invoices/${i.invoiceId}/attachment?version=1`,
          "GET",
          undefined,
          viewer,
        )
      ).status,
      403,
    );
    const second = s.create("payer", payload);
    s.approve("payer", second.invoiceId, 1);
    assert.equal(
      (
        await req(
          `/invoices/${second.invoiceId}/payment-attempts`,
          "POST",
          { version: 1 },
          payer,
          { "Idempotency-Key": "security-test-key" },
        )
      ).status,
      409,
    );
    for (const mode of ["L1", "L2"])
      assert.equal(
        (
          await req(
            `/invoices/${second.invoiceId}/payment-attempts`,
            "POST",
            { version: 1, mode },
            payer,
            { "Idempotency-Key": "real-mode-key" },
          )
        ).status,
        503,
      );
    now += 120001;
    assert.equal(
      (
        await req(
          `/payment-attempts/${a.id}/confirm`,
          "POST",
          { version: 1, quoteFingerprint: q.quote!.fingerprint },
          payer,
        )
      ).status,
      409,
    );
    assert.equal(s.status("payer", a.id).state, "QUOTED");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    store.close();
  }
});

test("actual multiprocess SQLite contention permits exactly one active attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-race-")),
    path = join(dir, "db"),
    key = randomBytes(32);
  const store = new Store(path, key),
    s = new Service(store);
  const i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  const at = Date.now() + 1000;
  try {
    const results = await Promise.all(
      Array.from(
        { length: 6 },
        (_, index) =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "tests/helpers/race.ts",
                path,
                key.toString("hex"),
                i.invoiceId,
                String(index),
                String(at),
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            let out = "",
              err = "";
            child.stdout.on("data", (b) => (out += b));
            child.stderr.on("data", (b) => (err += b));
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve(out.trim()) : reject(Error(err)),
            );
          }),
      ),
    );
    assert.equal(results.filter((r) => r === "CREATED").length, 1);
    assert.equal(
      results.filter((r) => r === "ACTIVE_ATTEMPT_EXISTS").length,
      5,
    );
    assert.equal(s.get("payer", i.invoiceId).attempts.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("real mode startup fails before creating data or identity state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-mode-"));
  try {
    for (const mode of ["L1", "L2"]) {
      const result = await new Promise<{ code: number | null; err: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "src/server.ts"],
            {
              env: {
                ...process.env,
                PAYMENT_MODE: mode,
                DATA_DIR: join(dir, "must-not-exist"),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let err = "";
          child.stderr.on("data", (b) => (err += b));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, err }));
        },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.err, /REAL_MODES_DISABLED/);
      assert.equal(existsSync(join(dir, "must-not-exist")), false);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("verifier exception does not crash HTTP server or invent success; explicit recheck recovers", async () => {
  const store = new Store(":memory:", randomBytes(32)),
    s = new Service(store);
  const i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  const a = s.start("payer", i.invoiceId, 1, "worker-error-key");
  const q = s.quote("payer", a.id);
  s.confirm("payer", a.id, 1, q.quote!.fingerprint);
  let called = false;
  const original = s.verify.bind(s);
  s.verify = () => {
    called = true;
    throw Error("test-only verifier fault");
  };
  const server = createApp(s).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const login = await fetch(base + "/api/demo/session", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user: "payer" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const result = await fetch(
      base + `/api/payment-attempts/${a.id}/execution-reference`,
      {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ reference: "sim:success" }),
      },
    );
    assert.equal(result.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(called, true);
    const status = await fetch(base + `/api/payment-attempts/${a.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, "SUBMITTED");
    assert.equal(s.get("payer", i.invoiceId).settled, false);
    s.verify = original;
    assert.equal(s.verify(a.id).state, "VERIFIED_SUCCESS");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    store.close();
  }
});

test("NEAR auth startup requires explicit complete config and PostgreSQL; never auto-enables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-auth-mode-"));
  try {
    const result = await new Promise<{ code: number | null; err: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "src/server.ts"],
          {
            env: {
              ...process.env,
              AUTH_MODE: "near",
              STORAGE_DRIVER: "sqlite",
              DATA_DIR: dir,
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let err = "";
        child.stderr.on("data", (b) => (err += b));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, err }));
      },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.err, /AUTH_CONFIGURATION_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
