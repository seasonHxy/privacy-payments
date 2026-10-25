import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { NearAuth } from "../../src/near-auth.js";
import { L1Service } from "../../src/l1.js";
import { createApp } from "../../src/server.js";
import { l1FixtureRpc, receiptFor } from "../helpers/l1-fixtures.js";
import { signingFixture, hash } from "../helpers/near-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
test("L1 HTTP actual auth + PostgreSQL, mock RPC only; no simulator access", async () => {
  const schema = "plh_" + randomBytes(8).toString("hex");
  const root = new Pool({ connectionString: url });
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const key = randomBytes(32),
    repo = new PostgresRepository(pool, key);
  await repo.migrate();
  const payer = signingFixture(),
    recipient = signingFixture(),
    viewer = signingFixture();
  const allowed = new Set([
    "payer-fixture.testnet|" + payer.publicKey,
    "recipient-fixture.testnet|" + recipient.publicKey,
    "viewer-fixture.testnet|" + viewer.publicKey,
  ]);
  const f = l1FixtureRpc(allowed);
  const origin = "http://127.0.0.1:3000";
  const auth = new NearAuth(
    pool,
    key,
    {
      origin,
      rpcUrl: f.config.rpcUrl,
      chainId: "testnet",
      genesisHash: f.config.genesisHash,
      members: {
        [f.config.payer]: "payer",
        [f.config.recipient]: "recipient",
        "viewer-fixture.testnet": "accountant",
      },
    },
    f.rpc,
  );
  let now = Date.now();
  const l1 = new L1Service(
    pool,
    key,
    f.config,
    f.rpc,
    () => now,
    "viewer-fixture.testnet",
  );
  assert.throws(
    () => createApp(repo.api(), origin, undefined, { l1 }),
    /L1_AUTH_CONFIGURATION/,
  );
  const server = createApp(repo.api(), origin, auth, { l1 }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (
    path: string,
    cookie = "",
    body?: unknown,
    extra: Record<string, string> = {},
    method = "POST",
  ) =>
    fetch(base + "/api" + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async (
    accountId: string,
    fixture: ReturnType<typeof signingFixture>,
  ) => {
    const cr = await request("/auth/challenge", "", { accountId });
    assert.equal(cr.status, 200);
    const c = await cr.json();
    const vr = await request(
      "/auth/verify",
      cr.headers.get("set-cookie")!.split(";")[0],
      {
        challengeId: c.challengeId,
        state: c.state,
        accountId,
        publicKey: fixture.publicKey,
        signature: fixture.sign(c),
      },
    );
    assert.equal(vr.status, 200);
    return vr.headers
      .getSetCookie()
      .find((v) => v.startsWith("near_session="))!
      .split(";")[0]!;
  };
  try {
    const cfg = await (await request("/l1/config")).json();
    assert.equal(cfg.enabled, true);
    assert.equal(JSON.stringify(cfg).includes(f.config.payer), false);
    assert.equal((await request("/l1/invoices")).status, 401);
    assert.equal(
      (await request("/demo/session", "", { user: "payer" })).status,
      403,
    );
    const pc = await login(f.config.payer, payer),
      rc = await login(f.config.recipient, recipient),
      vc = await login("viewer-fixture.testnet", viewer);
    assert.equal((await request("/invoices", pc)).status, 403);
    assert.deepEqual(await (await request("/l1/settings", vc)).json(), {
      enabled: true,
      role: "accountant",
    });
    const viewerMe = await (await request("/me", vc)).json();
    assert.equal(viewerMe.asset, undefined);
    assert.equal(JSON.stringify(viewerMe).includes(f.config.contract), false);
    assert.equal((await request("/l1/invoices", vc)).status, 403);
    assert.equal(
      (
        await request(
          "/l1/invoices",
          rc,
          { amountAtomic: "100", purpose: "fake" },
          { "Idempotency-Key": "http-fake-key" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/l1/invoices",
          pc,
          { amountAtomic: "100", purpose: "fake" },
          {
            Origin: "https://evil.invalid",
            "Idempotency-Key": "http-fake-key",
          },
        )
      ).status,
      403,
    );
    const create = () =>
      request(
        "/l1/invoices",
        pc,
        { amountAtomic: "100", purpose: "HTTP_FAKE_MARKER" },
        { "Idempotency-Key": "http-fake-key" },
      );
    const first = await create();
    assert.equal(first.status, 201);
    let i = await first.json();
    assert.equal((await (await create()).json()).id, i.id);
    assert.equal(
      (
        await request(
          "/l1/invoices",
          pc,
          { amountAtomic: "101", purpose: "HTTP_FAKE_MARKER" },
          { "Idempotency-Key": "http-fake-key" },
        )
      ).status,
      409,
    );
    const p = "/l1/invoices/" + i.id;
    assert.equal((await request(p, vc)).status, 403);
    assert.equal(
      (await request(p + "/approve", pc, { version: 2 })).status,
      409,
    );
    assert.equal(
      (await request(p + "/approve", pc, { version: 1 })).status,
      200,
    );
    i = await (await request(p + "/quote", pc, {})).json();
    assert.equal(
      (
        await request(p + "/confirm", pc, {
          version: 1,
          quoteFingerprint: "tampered",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(p + "/confirm", pc, {
          version: 1,
          quoteFingerprint: i.quote.fingerprint,
        })
      ).status,
      200,
    );
    i = await (await request(p + "/prepare-signing", pc, {})).json();
    assert.equal(i.state, "AWAITING_SIGNATURE");
    assert.equal(
      (
        await request(p + "/execution-reference", pc, {
          reference: "sim:success",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(p + "/execution-reference", pc, {
          reference: hash(3),
          state: "VERIFIED_SUCCESS",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(p + "/execution-reference", pc, { reference: hash(3) }))
        .status,
      202,
    );
    assert.equal((await (await request(p, pc)).json()).state, "SUBMITTED");
    f.rpcControl.receipt = receiptFor(i);
    const checked = await request(p + "/recheck", rc, {});
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).state, "VERIFIED_SUCCESS");
    assert.equal((await request(p + "/acknowledgement", pc, {})).status, 403);
    assert.ok(
      (await (await request(p + "/acknowledgement", rc, {})).json())
        .acknowledgedAt,
    );
    const read = await request(p, rc);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal((await request(p + "/prepare-signing", pc, {})).status, 409);
    assert.equal(
      (await pool.query("SELECT count(*) FROM invoices")).rows[0].count,
      "0",
    );
    // Scope, attachment and export all use the same current authorization, including conditional reads.
    const payload = {
      amountAtomic: "100",
      purpose: "HIDDEN_SCOPE_PURPOSE",
      attachment: {
        name: "note.txt",
        type: "text/plain",
        content: "OLD_SCOPE_ATTACHMENT",
      },
    };
    const scoped = await (
      await request("/l1/invoices", pc, payload, {
        "Idempotency-Key": "scoped-http-fixture",
      })
    ).json();
    const scopedPath = "/l1/invoices/" + scoped.id;
    await request(scopedPath + "/approve", pc, { version: 1 });
    const oq = await (await request(scopedPath + "/quote", pc, {})).json();
    const edit = await request(
      scopedPath,
      pc,
      {
        expectedVersion: 1,
        payload: {
          ...payload,
          amountAtomic: "101",
          attachment: {
            ...payload.attachment,
            content: "NEW_SCOPE_ATTACHMENT",
          },
        },
      },
      {},
      "PATCH",
    );
    assert.equal(edit.status, 200);
    assert.equal((await edit.json()).version, 2);
    assert.equal(
      (
        await request(scopedPath + "/confirm", pc, {
          version: 1,
          quoteFingerprint: oq.quote.fingerprint,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          scopedPath,
          vc,
          { expectedVersion: 2, payload },
          {},
          "PATCH",
        )
      ).status,
      403,
    );
    const ownFile = await request(scopedPath + "/attachment?version=1", pc);
    assert.equal(await ownFile.text(), "OLD_SCOPE_ATTACHMENT");
    assert.equal(ownFile.headers.get("cache-control"), "no-store");
    assert.match(ownFile.headers.get("content-disposition")!, /^attachment/);
    const grantBody = {
      invoiceId: scoped.id,
      version: 1,
      recipient: "viewer-fixture.testnet",
      fields: ["amountAtomic", "attachment"],
      expiresAt: now + 60000,
    };
    assert.equal((await request("/l1/disclosures", rc, grantBody)).status, 403);
    const gr = await request("/l1/disclosures", pc, grantBody);
    assert.equal(gr.status, 201);
    const g = await gr.json(),
      gp = "/l1/disclosures/" + g.id;
    assert.equal((await request(gp + "/export")).status, 401);
    assert.equal((await request(gp, rc)).status, 403);
    const revealed = await (await request(gp, vc)).json();
    assert.equal(revealed.fields.amountAtomic, "100");
    assert.deepEqual(Object.keys(revealed.fields).sort(), [
      "amountAtomic",
      "attachment",
    ]);
    for (const secret of [
      payload.purpose,
      "OLD_SCOPE_ATTACHMENT",
      "NEW_SCOPE_ATTACHMENT",
      f.config.payer,
      f.config.contract,
    ])
      assert.equal(JSON.stringify(revealed).includes(secret), false);
    const exported = await request(gp + "/export", vc);
    assert.equal(exported.status, 200);
    assert.deepEqual(await exported.json(), revealed);
    assert.equal(exported.headers.get("cache-control"), "no-store");
    assert.match(exported.headers.get("content-disposition")!, /^attachment/);
    const file = await request(gp + "/attachment", vc);
    assert.equal(await file.text(), "OLD_SCOPE_ATTACHMENT");
    assert.equal(file.headers.get("cache-control"), "no-store");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.match(file.headers.get("content-type")!, /^text\/plain/);
    assert.equal(
      (await request(scopedPath + "/attachment?version=1", vc)).status,
      403,
    );
    assert.equal(
      (await request("/invoices/" + scoped.id + "/attachment?version=1", vc))
        .status,
      403,
    );
    assert.equal((await request(gp, vc, {}, {}, "DELETE")).status, 403);
    assert.equal(
      (await request(gp, pc, {}, { Origin: "https://evil.invalid" }, "DELETE"))
        .status,
      403,
    );
    assert.equal((await request(gp, pc, {}, {}, "DELETE")).status, 200);
    for (const suffix of ["", "/export", "/attachment"]) {
      const r = await request(gp + suffix, vc, undefined, {
        "If-None-Match": "*",
        "If-Modified-Since": new Date().toUTCString(),
      });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    const exp = await (
      await request("/l1/disclosures", pc, {
        ...grantBody,
        expiresAt: now + 1000,
      })
    ).json();
    now += 1001;
    for (const suffix of ["", "/export", "/attachment"])
      assert.equal(
        (await request("/l1/disclosures/" + exp.id + suffix, vc)).status,
        403,
      );
    assert.deepEqual(await (await request("/l1/disclosures", vc)).json(), []);
    assert.ok(
      f.rpcControl.calls.every((c) =>
        ["query", "status", "tx_status", "block"].includes(c.method),
      ),
    );
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await repo.close();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
