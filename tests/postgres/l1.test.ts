import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { L1Service, l1ConfigSchema, atomic } from "../../src/l1.js";
import { l1FixtureRpc, receiptFor } from "../helpers/l1-fixtures.js";
import { hash } from "../helpers/near-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
test("L1 isolated persistent workflow, actual PostgreSQL with exclusively mock RPC", async (t) => {
  const schema = "pl1_" + randomBytes(8).toString("hex"),
    root = new Pool({ connectionString: url });
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  await pool.query(readFileSync("migrations/003_l1.sql", "utf8"));
  const fixture = l1FixtureRpc(),
    key = randomBytes(32);
  let now = Date.now();
  let svc = new L1Service(pool, key, fixture.config, fixture.rpc, () => now);
  const payer = { accountId: fixture.config.payer, user: "payer" as const },
    recipient = {
      accountId: fixture.config.recipient,
      user: "recipient" as const,
    };
  let n = 0;
  async function ready() {
    fixture.control.blockTimestampNs = (BigInt(now + 1) * 1000000n).toString();
    const i = await svc.create(
      payer,
      { amountAtomic: "100", purpose: "fixture-only" },
      "key-ready-" + n++,
    );
    await svc.approve(payer, i.id, 1);
    const q = await svc.quote(payer, i.id);
    await svc.confirm(payer, i.id, 1, q.quote!.fingerprint);
    return svc.prepare(payer, i.id);
  }
  try {
    await t.test(
      "configuration strict, integer range and role/account isolation",
      async () => {
        assert.throws(() =>
          l1ConfigSchema.parse({ ...fixture.config, chainId: "mainnet" }),
        );
        assert.throws(() => atomic.parse("0"));
        assert.throws(() => atomic.parse((1n << 128n).toString()));
        await assert.rejects(
          svc.list({ accountId: fixture.config.payer, user: "admin" }),
        );
        await assert.rejects(
          svc.create(
            recipient,
            { amountAtomic: "100", purpose: "x" },
            "forbidden-key",
          ),
        );
      },
    );
    await t.test(
      "concurrent identical key reuses one invoice, changed params conflict",
      async () => {
        const r = await Promise.all(
          Array.from({ length: 6 }, () =>
            svc.create(
              payer,
              { amountAtomic: "100", purpose: "race" },
              "race-fixture-key",
            ),
          ),
        );
        assert.equal(new Set(r.map((x) => x.id)).size, 1);
        await assert.rejects(
          svc.create(
            payer,
            { amountAtomic: "101", purpose: "race" },
            "race-fixture-key",
          ),
          /IDEMPOTENCY_CONFLICT/,
        );
      },
    );
    await t.test(
      "storage/metadata/insufficient balance fail closed without creating request",
      async () => {
        const i = await svc.create(
          payer,
          { amountAtomic: "100", purpose: "preflight" },
          "preflight-key",
        );
        await svc.approve(payer, i.id, 1);
        fixture.control.registered = false;
        await assert.rejects(
          svc.quote(payer, i.id),
          /STORAGE_REGISTRATION_REQUIRED/,
        );
        fixture.control.registered = true;
        fixture.control.decimals = 8;
        await assert.rejects(svc.quote(payer, i.id), /TOKEN_METADATA_MISMATCH/);
        fixture.control.decimals = 6;
        fixture.control.balance = "1";
        await assert.rejects(svc.quote(payer, i.id), /INSUFFICIENT/);
        fixture.control.balance = "1000000000";
        assert.equal((await svc.get(payer, i.id)).state, "APPROVED");
      },
    );
    await t.test(
      "bound exact request, expiry after RPC and immutable signed phase",
      async () => {
        const i = await svc.create(
          payer,
          { amountAtomic: "100", purpose: "expiry" },
          "expiry-key",
        );
        await svc.approve(payer, i.id, 1);
        const q = await svc.quote(payer, i.id);
        await assert.rejects(svc.confirm(payer, i.id, 2, q.quote!.fingerprint));
        await assert.rejects(svc.confirm(payer, i.id, 1, "tampered"));
        await svc.confirm(payer, i.id, 1, q.quote!.fingerprint);
        fixture.control.beforeQuery = async () => {
          now += 120001;
        };
        await assert.rejects(svc.prepare(payer, i.id), /QUOTE_EXPIRED/);
        fixture.control.beforeQuery = async () => {};
        assert.equal((await svc.get(payer, i.id)).state, "CONFIRMED");
      },
    );
    await t.test(
      "UNKNOWN persists across service restart and cannot re-prepare or replace hash",
      async () => {
        const i = await ready();
        await svc.submit(payer, i.id, hash(3));
        fixture.control.offline = true;
        assert.equal((await svc.recheck(payer, i.id)).state, "UNKNOWN");
        fixture.control.offline = false;
        svc = new L1Service(pool, key, fixture.config, fixture.rpc, () => now);
        assert.equal((await svc.get(payer, i.id)).state, "UNKNOWN");
        await assert.rejects(svc.prepare(payer, i.id));
        await assert.rejects(svc.submit(payer, i.id, hash(9)));
      },
    );
    await t.test(
      "historical/mutated request cannot settle; valid bound fixture plus recipient acknowledgement",
      async () => {
        const i = await ready();
        const repeated = await Promise.all([
          svc.prepare(payer, i.id),
          svc.prepare(payer, i.id),
        ]);
        assert.deepEqual(
          repeated[0]!.quote!.request,
          repeated[1]!.quote!.request,
        );
        assert.deepEqual(repeated[0]!.quote!.request, i.quote!.request);
        await svc.submit(payer, i.id, hash(3));
        const replay = await svc.submit(payer, i.id, hash(3));
        assert.equal(replay.reference, hash(3));
        assert.equal(replay.state, "SUBMITTED");
        const r = receiptFor(i);
        const wrong = structuredClone(r);
        wrong.transaction.actions[0]!.FunctionCall.args = Buffer.from(
          JSON.stringify({
            receiver_id: fixture.config.recipient,
            amount: "100",
            memo: "old-transfer",
          }),
        ).toString("base64");
        fixture.rpcControl.receipt = wrong;
        assert.equal((await svc.recheck(payer, i.id)).state, "REVIEW_REQUIRED");
        fixture.rpcControl.receipt = r;
        assert.equal(
          (await svc.recheck(payer, i.id)).state,
          "VERIFIED_SUCCESS",
        );
        await assert.rejects(svc.acknowledge(payer, i.id));
        assert.ok((await svc.acknowledge(recipient, i.id)).acknowledgedAt);
        await assert.rejects(svc.quote(payer, i.id));
        assert.equal(
          (await pool.query("SELECT count(*) FROM l1_events")).rows[0].count,
          "1",
        );
      },
    );
    await t.test(
      "same settlement event cannot settle second invoice even with otherwise matching fixture",
      async () => {
        const i = await ready();
        await svc.submit(payer, i.id, hash(3));
        fixture.rpcControl.receipt = receiptFor(i);
        assert.equal((await svc.recheck(payer, i.id)).state, "REVIEW_REQUIRED");
        assert.equal(
          (await pool.query("SELECT count(*) FROM l1_events")).rows[0].count,
          "1",
        );
      },
    );
    await t.test(
      "late execution is review required even if exported request otherwise matches",
      async () => {
        const i = await ready();
        await svc.submit(payer, i.id, hash(3));
        fixture.rpcControl.receipt = receiptFor(i);
        fixture.control.blockTimestampNs = (
          BigInt(i.quote!.expiresAt + 1) * 1000000n
        ).toString();
        assert.equal((await svc.recheck(payer, i.id)).state, "REVIEW_REQUIRED");
        assert.equal(
          (await pool.query("SELECT count(*) FROM l1_events")).rows[0].count,
          "1",
        );
      },
    );
    await t.test(
      "simultaneous verification uses revision CAS and preserves one response",
      async () => {
        const i = await ready();
        await svc.submit(payer, i.id, hash(3));
        fixture.rpcControl.receipt = { final_execution_status: "INCLUDED" };
        let entered = 0;
        let unblock: () => void = () => {};
        const gate = new Promise<void>((r) => {
          unblock = r;
        });
        fixture.control.beforeReceipt = async () => {
          entered++;
          if (entered === 2) unblock();
          await gate;
        };
        const result = await Promise.allSettled([
          svc.recheck(payer, i.id),
          svc.recheck(payer, i.id),
        ]);
        fixture.control.beforeReceipt = async () => {};
        assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(result.filter((r) => r.status === "rejected").length, 1);
        assert.equal((await svc.get(payer, i.id)).state, "UNKNOWN");
      },
    );
    await t.test(
      "failed event insertion rolls back invoice update and allows safe recheck",
      async () => {
        const i = await ready();
        await svc.submit(payer, i.id, hash(3));
        fixture.rpcControl.receipt = receiptFor(i);
        await pool.query(
          "CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$",
        );
        await pool.query(
          "CREATE TRIGGER reject_event BEFORE INSERT ON l1_events FOR EACH ROW EXECUTE FUNCTION reject_event()",
        );
        await assert.rejects(svc.recheck(payer, i.id), /fixture rollback/);
        assert.equal((await svc.get(payer, i.id)).state, "SUBMITTED");
        await pool.query("DROP TRIGGER reject_event ON l1_events");
        await pool.query("DROP FUNCTION reject_event()");
        assert.equal(
          (await pool.query("SELECT count(*) FROM l1_events")).rows[0].count,
          "1",
        );
      },
    );
    await t.test(
      "ciphertext hides fake purpose and wrong config/key refuse persisted rows",
      async () => {
        const rows = await pool.query("SELECT payload FROM l1_invoices");
        assert.ok(
          rows.rows.every(
            (r) => !r.payload.includes(Buffer.from("fixture-only")),
          ),
        );
        await assert.rejects(
          new L1Service(
            pool,
            randomBytes(32),
            fixture.config,
            fixture.rpc,
          ).list(payer),
        );
        await assert.rejects(
          new L1Service(
            pool,
            key,
            { ...fixture.config, gas: "40000000000000" },
            fixture.rpc,
          ).list(payer),
        );
        assert.ok(
          fixture.rpcControl.calls.every((r) =>
            ["status", "query", "tx_status", "block"].includes(r.method),
          ),
        );
      },
    );
  } finally {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
