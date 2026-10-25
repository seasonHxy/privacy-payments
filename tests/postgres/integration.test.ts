import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { createApp } from "../../src/server.js";
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error(
    "TEST_DATABASE_URL required; PostgreSQL tests must not silently skip",
  );
const payload = {
  amountAtomic: "1000000",
  asset: "mock:USD",
  network: "mock-local",
  recipient: "recipient",
  address: "demo:recipient",
  purpose: "PG_PRIVATE_MARKER",
  attachment: {
    name: "note.txt",
    type: "text/plain",
    content: "PG_PRIVATE_ATTACHMENT",
  },
};

test("real PostgreSQL integration (isolated disposable schema)", async (t) => {
  const schema = "pp_" + randomBytes(8).toString("hex");
  const root = new Pool({ connectionString: url });
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const key = randomBytes(32);
  let now = Date.now();
  let repo = new PostgresRepository(pool, key, () => now),
    api = repo.api();
  async function approved() {
    const i = await api.create("payer", payload);
    await api.approve("payer", i.invoiceId, 1);
    return i;
  }
  async function ready() {
    const i = await approved();
    const a = await api.start("payer", i.invoiceId, 1, randomUUID());
    const q = await api.quote("payer", a.id);
    await api.confirm("payer", a.id, 1, q.quote!.fingerprint);
    return { i, a };
  }
  try {
    await t.test(
      "migration executes on real engine, repeats safely, relational tables exist",
      async () => {
        await repo.migrate();
        await repo.migrate();
        const version = await pool.query("SELECT version()");
        assert.match(version.rows[0].version, /PostgreSQL 18/);
        assert.equal(
          (await pool.query("SELECT * FROM schema_migrations")).rowCount,
          4,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1",
              [schema],
            )
          ).rows[0].n,
          17,
        );
      },
    );
    await t.test(
      "idempotency across connections, different invoice conflicts, real unique indexes",
      async () => {
        const i = await approved(),
          j = await approved();
        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            api.start("payer", i.invoiceId, 1, "pg-idempotent-key"),
          ),
        );
        assert.equal(new Set(responses.map((a) => a.id)).size, 1);
        await assert.rejects(
          api.start("payer", j.invoiceId, 1, "pg-idempotent-key"),
          (e: any) => e.code === "IDEMPOTENCY_CONFLICT",
        );
        const a = responses[0]!;
        await assert.rejects(
          pool.query(
            "INSERT INTO payment_attempts SELECT $1,workspace_id,invoice_id,version,approval_id,idempotency_tag,state,revision,payload FROM payment_attempts WHERE id=$2",
            [randomUUID(), a.id],
          ),
          (e: any) => e.code === "23505",
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO payment_attempts SELECT $1,workspace_id,invoice_id,version,approval_id,$2,state,revision,payload FROM payment_attempts WHERE id=$3",
            [randomUUID(), randomBytes(32), a.id],
          ),
          (e: any) =>
            e.code === "23505" && e.constraint === "one_active_attempt",
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO invoice_versions SELECT * FROM invoice_versions WHERE invoice_id=$1",
            [i.invoiceId],
          ),
          (e: any) => e.code === "23505",
        );
        await assert.rejects(
          pool.query(
            "UPDATE invoice_versions SET payload=payload WHERE invoice_id=$1",
            [i.invoiceId],
          ),
          (e: any) => e.code === "23514",
        );
      },
    );
    await t.test(
      "six Node processes compete; exactly one attempt is committed",
      async () => {
        const i = await approved();
        const when = Date.now() + 1000;
        const results = await Promise.all(
          Array.from(
            { length: 6 },
            (_, n) =>
              new Promise<string>((resolve, reject) => {
                const child = spawn(
                  process.execPath,
                  [
                    "--import",
                    "tsx",
                    "tests/helpers/pg-race.ts",
                    key.toString("hex"),
                    i.invoiceId,
                    String(n),
                    String(when),
                  ],
                  {
                    env: {
                      ...process.env,
                      TEST_DATABASE_URL: url,
                      PG_TEST_SCHEMA: schema,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                  },
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
        assert.equal(results.filter((x) => x === "CREATED").length, 1);
        assert.equal(
          results.filter((x) => x === "ACTIVE_ATTEMPT_EXISTS").length,
          5,
        );
        assert.equal((await api.get("payer", i.invoiceId)).attempts.length, 1);
      },
    );
    await t.test(
      "quote expiry rolls back; old approvals invalidated on version change",
      async () => {
        const i = await approved(),
          a = await api.start("payer", i.invoiceId, 1, randomUUID());
        const q = await api.quote("payer", a.id);
        now += 120001;
        await assert.rejects(
          api.confirm("payer", a.id, 1, q.quote!.fingerprint),
          (e: any) => e.code === "QUOTE_EXPIRED",
        );
        assert.equal((await api.status("payer", a.id)).state, "QUOTED");
        await api.edit("payer", i.invoiceId, 1, {
          ...payload,
          amountAtomic: "2",
        });
        await assert.rejects(
          api.start("payer", i.invoiceId, 2, randomUUID()),
          (e: any) => e.code === "APPROVAL_REQUIRED",
        );
        assert.equal(
          (await api.get("payer", i.invoiceId)).versions[0]!.payload
            .amountAtomic,
          "1000000",
        );
      },
    );
    await t.test(
      "SQL failure after state write rolls entire transaction back",
      async () => {
        const { i, a } = await ready();
        await api.submit("payer", a.id, "sim:success");
        const snapshot = await api.status("payer", a.id);
        await pool.query(
          "CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$; CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_audit()",
        );
        await assert.rejects(api.verify(a.id, snapshot.revision));
        await pool.query(
          "DROP TRIGGER injected_failure ON audit_events; DROP FUNCTION fail_audit()",
        );
        assert.equal((await api.status("payer", a.id)).state, "SUBMITTED");
        assert.equal((await api.get("payer", i.invoiceId)).settled, false);
        assert.equal(
          (
            await pool.query(
              "SELECT * FROM settlement_evidence WHERE attempt_id=$1",
              [a.id],
            )
          ).rowCount,
          0,
        );
        await api.verify(a.id, snapshot.revision);
      },
    );
    await t.test(
      "state-version CAS rejects late worker and repeated snapshots",
      async () => {
        const { a } = await ready();
        const submitted = await api.submit("payer", a.id, "sim:success");
        const results = await Promise.allSettled([
          api.verify(a.id, submitted.revision),
          api.verify(a.id, submitted.revision),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const rejection = results.find(
          (r) => r.status === "rejected",
        ) as PromiseRejectedResult;
        assert.equal(rejection.reason.code, "STALE_VERIFICATION");
        assert.equal(
          (
            await pool.query(
              "UPDATE payment_attempts SET revision=revision+1 WHERE id=$1 AND revision=$2",
              [a.id, submitted.revision],
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      "restart recovers same submitted attempt; UNKNOWN remains locked",
      async () => {
        const { i, a } = await ready();
        await api.submit("payer", a.id, "sim:success");
        await repo.close();
        repo = new PostgresRepository(
          new Pool({
            connectionString: url,
            options: `-c search_path=${schema}`,
          }),
          key,
          () => now,
        );
        api = repo.api();
        await api.recover();
        assert.equal(
          (await api.status("payer", a.id)).state,
          "VERIFIED_SUCCESS",
        );
        await assert.rejects(
          api.start("payer", i.invoiceId, 1, randomUUID()),
          (e: any) => e.code === "ALREADY_SETTLED",
        );
        const timeout = await ready();
        await api.submit("payer", timeout.a.id, "sim:timeout");
        await api.verify(timeout.a.id);
        await api.recover();
        assert.equal(
          (await api.status("payer", timeout.a.id)).state,
          "UNKNOWN",
        );
        await assert.rejects(
          api.start("payer", timeout.i.invoiceId, 1, randomUUID()),
          (e: any) => e.code === "ACTIVE_ATTEMPT_EXISTS",
        );
      },
    );
    await t.test(
      "unique settlement event, attachment and scoped disclosure permissions, ciphertext",
      async () => {
        const { i, a } = await ready();
        await api.submit("payer", a.id, "sim:success");
        await api.verify(a.id);
        await api.acknowledge("recipient", i.invoiceId);
        const other = await ready();
        await assert.rejects(
          repo.pool.query(
            "INSERT INTO settlement_evidence SELECT $1,workspace_id,event_tag,payload FROM settlement_evidence WHERE attempt_id=$2",
            [other.a.id, a.id],
          ),
          (e: any) => e.code === "23505",
        );
        const g = await api.grant("payer", {
          invoiceId: i.invoiceId,
          version: 1,
          recipient: "accountant",
          fields: ["asset", "evidence"],
          expiresAt: now + 1000,
        });
        const d = await api.disclosure("accountant", g.id);
        assert.equal(d.amountAtomic, undefined);
        assert.equal(d.address, undefined);
        assert.equal((d.evidence as any).receivedAcknowledged, true);
        await assert.rejects(
          api.get("accountant", i.invoiceId),
          (e: any) => e.code === "OBJECT_FORBIDDEN",
        );
        await api.revoke("payer", g.id);
        await assert.rejects(
          api.disclosure("accountant", g.id),
          (e: any) => e.code === "DISCLOSURE_EXPIRED_OR_REVOKED",
        );
        const rows = await repo.pool.query(
          "SELECT payload FROM invoice_versions",
        );
        assert.ok(
          rows.rows.every(
            (r) => !r.payload.includes(Buffer.from("PG_PRIVATE_MARKER")),
          ),
        );
      },
    );
    await t.test(
      "metadata, key/AAD integrity and cross-workspace foreign keys fail closed",
      async () => {
        const i = await approved();
        await repo.pool.query("UPDATE invoices SET settled=true WHERE id=$1", [
          i.invoiceId,
        ]);
        await assert.rejects(
          api.get("payer", i.invoiceId),
          (e: any) => e.code === "INVOICE_METADATA_MISMATCH",
        );
        await repo.pool.query("UPDATE invoices SET settled=false WHERE id=$1", [
          i.invoiceId,
        ]);
        await assert.rejects(
          repo.pool.query(
            "INSERT INTO approvals(id,workspace_id,invoice_id,version,active,payload) VALUES($1,$2,$3,1,false,$4)",
            [randomUUID(), "other", i.invoiceId, Buffer.from("fixture")],
          ),
          (e: any) => e.code === "23503",
        );
        const wrong = new PostgresRepository(
          new Pool({
            connectionString: url,
            options: `-c search_path=${schema}`,
          }),
          randomBytes(32),
        );
        try {
          await assert.rejects(wrong.api().get("payer", i.invoiceId));
        } finally {
          await wrong.close();
        }
        const audit = await repo.pool.query(
          "SELECT id,payload FROM audit_events WHERE workspace_id=$1 ORDER BY id LIMIT 2",
          ["demo"],
        );
        assert.equal(audit.rowCount, 2);
        const [first, second] = audit.rows;
        await repo.pool.query(
          "UPDATE audit_events SET payload=$1 WHERE id=$2",
          [second.payload, first.id],
        );
        await assert.rejects(api.get("payer", i.invoiceId));
        await repo.pool.query(
          "UPDATE audit_events SET payload=$1 WHERE id=$2",
          [first.payload, first.id],
        );
        assert.equal((await api.get("payer", i.invoiceId)).settled, false);
      },
    );
    await t.test(
      "HTTP app uses async PostgreSQL API without leaking Promise placeholders",
      async () => {
        const server = createApp(api).listen(0, "127.0.0.1");
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
          const response = await fetch(base + "/api/invoices", {
            headers: { Cookie: cookie },
          });
          assert.equal(response.status, 200);
          const invoices = await response.json();
          assert.ok(Array.isArray(invoices) && invoices.length > 0);
        } finally {
          await new Promise<void>((r, j) =>
            server.close((e) => (e ? j(e) : r())),
          );
        }
      },
    );
  } finally {
    await repo.close();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
