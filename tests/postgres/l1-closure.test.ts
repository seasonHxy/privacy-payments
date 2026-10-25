import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { L1Service } from "../../src/l1.js";
import { l1FixtureRpc, receiptFor } from "../helpers/l1-fixtures.js";
import { hash } from "../helpers/near-fixtures.js";
import { seal, unseal } from "../../src/domain.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
test("L1 version and scoped disclosure closure on actual PostgreSQL; RPC fixtures only", async (t) => {
  const schema = "plc_" + randomBytes(8).toString("hex"),
    root = new Pool({ connectionString: url });
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    }),
    key = randomBytes(32),
    repo = new PostgresRepository(pool, key);
  await repo.migrate();
  const f = l1FixtureRpc();
  let now = Date.now();
  const viewer = {
      user: "accountant" as const,
      accountId: "viewer-fixture.testnet",
    },
    payer = { user: "payer" as const, accountId: f.config.payer },
    recipient = { user: "recipient" as const, accountId: f.config.recipient };
  const svc = new L1Service(
    pool,
    key,
    f.config,
    f.rpc,
    () => now,
    viewer.accountId,
  );
  const attachment = {
    name: "note.txt",
    type: "text/plain" as const,
    content: "PRIVATE_ATTACHMENT_V1",
  };
  const input = {
    amountAtomic: "100",
    purpose: "PRIVATE_PURPOSE_V1",
    attachment,
  };
  const make = () => svc.create(payer, input, randomUUID());
  const grant = (id: string, version: number, fields: string[], extra = {}) =>
    svc.grant(payer, {
      invoiceId: id,
      version,
      recipient: viewer.accountId,
      fields,
      expiresAt: now + 60000,
      ...extra,
    });
  try {
    await t.test(
      "immutable versions, original idempotency and stale approvals/quotes",
      async () => {
        const k = randomUUID(),
          i = await svc.create(payer, input, k);
        await svc.approve(payer, i.id, 1);
        const q = await svc.quote(payer, i.id);
        await svc.confirm(payer, i.id, 1, q.quote!.fingerprint);
        const edited = await svc.edit(payer, i.id, 1, {
          ...input,
          amountAtomic: "101",
          attachment: { ...attachment, content: "PRIVATE_ATTACHMENT_V2" },
        });
        assert.equal(edited.version, 2);
        assert.equal(edited.state, "CREATED");
        assert.equal(edited.approval, undefined);
        assert.equal(edited.quote, undefined);
        assert.equal(edited.confirmedAt, undefined);
        assert.equal(
          edited.retiredPayments![0]!.quote!.fingerprint,
          q.quote!.fingerprint,
        );
        await assert.rejects(svc.confirm(payer, i.id, 1, q.quote!.fingerprint));
        await assert.rejects(svc.approve(payer, i.id, 1));
        await assert.rejects(svc.prepare(payer, i.id));
        assert.equal((await svc.create(payer, input, k)).id, i.id);
        await assert.rejects(
          svc.create(payer, { ...input, amountAtomic: "101" }, k),
          /IDEMPOTENCY_CONFLICT/,
        );
        const got = await svc.get(payer, i.id);
        assert.deepEqual(
          got.versions.map((v) => v.payload.amountAtomic),
          ["100", "101"],
        );
        assert.equal(
          (await svc.attachment(payer, i.id, 1)).content,
          "PRIVATE_ATTACHMENT_V1",
        );
        await assert.rejects(
          pool.query(
            "UPDATE l1_invoice_versions SET payload=$1 WHERE invoice_id=$2",
            [Buffer.from("bad"), i.id],
          ),
          /immutable/,
        );
        await assert.rejects(
          pool.query("DELETE FROM l1_invoice_versions WHERE invoice_id=$1", [
            i.id,
          ]),
          /immutable/,
        );
        await assert.rejects(
          svc.edit(payer, i.id, 1, input),
          /VERSION_CONFLICT/,
        );
        await assert.rejects(
          svc.edit(payer, i.id, 2, { ...input, recipient: "unlisted.testnet" }),
        );
        await assert.rejects(
          svc.edit(payer, i.id, 2, { ...input, network: "mainnet" }),
        );
      },
    );
    await t.test(
      "attachment-only edit invalidates approval; unsafe MIME and oversized UTF8 rejected",
      async () => {
        const i = await make();
        await svc.approve(payer, i.id, 1);
        const edited = await svc.edit(payer, i.id, 1, {
          ...input,
          attachment: { ...attachment, content: "new" },
        });
        assert.equal(edited.version, 2);
        assert.equal(edited.approval, undefined);
        await assert.rejects(
          svc.edit(payer, i.id, 2, {
            ...input,
            attachment: { ...attachment, type: "text/html" },
          }),
        );
        await assert.rejects(
          svc.edit(payer, i.id, 2, {
            ...input,
            attachment: { ...attachment, content: "中".repeat(22000) },
          }),
        );
        assert.equal((await svc.get(payer, i.id)).version, 2);
      },
    );
    await t.test(
      "concurrent editors and prepare versus edit serialize with one winner",
      async () => {
        const i = await make();
        const edits = await Promise.allSettled([
          svc.edit(payer, i.id, 1, { ...input, amountAtomic: "101" }),
          svc.edit(payer, i.id, 1, { ...input, amountAtomic: "102" }),
        ]);
        assert.equal(edits.filter((x) => x.status === "fulfilled").length, 1);
        await svc.approve(payer, i.id, 2);
        const q = await svc.quote(payer, i.id);
        await svc.confirm(payer, i.id, 2, q.quote!.fingerprint);
        const race = await Promise.allSettled([
          svc.prepare(payer, i.id),
          svc.edit(payer, i.id, 2, input),
        ]);
        assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
        assert.equal(race.filter((x) => x.status === "rejected").length, 1);
      },
    );
    await t.test(
      "signature/submission/UNKNOWN lock all version edits and duplicate payment paths",
      async () => {
        const i = await make();
        await svc.approve(payer, i.id, 1);
        const q = await svc.quote(payer, i.id);
        await svc.confirm(payer, i.id, 1, q.quote!.fingerprint);
        await svc.prepare(payer, i.id);
        await assert.rejects(svc.edit(payer, i.id, 1, input), /PAYMENT_LOCKED/);
        await svc.submit(payer, i.id, hash(3));
        await assert.rejects(svc.edit(payer, i.id, 1, input), /PAYMENT_LOCKED/);
        f.rpcControl.receipt = { final_execution_status: "INCLUDED" };
        assert.equal((await svc.recheck(payer, i.id)).state, "UNKNOWN");
        await assert.rejects(svc.edit(payer, i.id, 1, input), /PAYMENT_LOCKED/);
        await assert.rejects(svc.quote(payer, i.id));
        await assert.rejects(svc.prepare(payer, i.id));
      },
    );
    await t.test(
      "specified version/recipient/field projection, no other invoice or raw evidence",
      async () => {
        const i = await make(),
          other = await make();
        const g = await grant(i.id, 1, ["amountAtomic", "settlement"]);
        await svc.edit(payer, i.id, 1, { ...input, amountAtomic: "200" });
        const d = await svc.disclosure(viewer, g.id);
        assert.equal(d.version, 1);
        assert.deepEqual(Object.keys(d.fields).sort(), [
          "amountAtomic",
          "settlement",
        ]);
        assert.equal(d.fields.amountAtomic, "100");
        assert.deepEqual(d.fields.settlement, {
          status: "NO_SETTLEMENT_FOR_VERSION",
          verified: false,
          recipientAcknowledged: false,
        });
        const text = JSON.stringify(d);
        for (const secret of [
          input.purpose,
          attachment.content,
          f.config.payer,
          f.config.recipient,
          f.config.contract,
          other.id,
        ])
          assert.equal(text.includes(secret), false);
        await assert.rejects(svc.get(viewer, i.id));
        await assert.rejects(svc.list(viewer));
        await assert.rejects(svc.attachment(viewer, i.id, 1));
        await assert.rejects(svc.disclosure(recipient, g.id));
        await assert.rejects(
          svc.disclosure(
            { ...viewer, accountId: "other-fixture.testnet" },
            g.id,
          ),
        );
        await assert.rejects(svc.disclosure(viewer, randomUUID()));
        await assert.rejects(grant(i.id, 99, ["purpose"]));
        await assert.rejects(grant(i.id, 1, ["evidence"]));
        await assert.rejects(
          grant(i.id, 1, ["purpose"], { recipient: f.config.recipient }),
        );
        await assert.rejects(grant(i.id, 1, ["purpose"], { expiresAt: now }));
        await assert.rejects(svc.grant(viewer, {}));
        await assert.rejects(svc.revoke(viewer, g.id));
      },
    );
    await t.test(
      "attachment grants preserve old content; revoke/expiry block fresh read and download",
      async () => {
        const i = await make();
        const g = await grant(i.id, 1, ["attachment"]),
          noFile = await grant(i.id, 1, ["amountAtomic"]);
        await svc.edit(payer, i.id, 1, {
          ...input,
          attachment: { ...attachment, content: "new attachment" },
        });
        assert.equal(
          (await svc.disclosedAttachment(viewer, g.id)).content,
          attachment.content,
        );
        const d = await svc.disclosure(viewer, g.id);
        assert.equal(JSON.stringify(d).includes(attachment.content), false);
        await assert.rejects(
          svc.disclosedAttachment(viewer, noFile.id),
          /ATTACHMENT_FORBIDDEN/,
        );
        await svc.revoke(payer, g.id);
        await svc.revoke(payer, g.id);
        await assert.rejects(
          svc.disclosure(viewer, g.id),
          /DISCLOSURE_FORBIDDEN/,
        );
        await assert.rejects(svc.disclosedAttachment(viewer, g.id));
        const exp = await grant(i.id, 1, ["attachment"]);
        const before = now;
        now += 60001;
        await assert.rejects(svc.disclosure(viewer, exp.id));
        await assert.rejects(svc.disclosedAttachment(viewer, exp.id));
        now = before;
        assert.ok(
          (await svc.get(payer, i.id)).audit!.some(
            (e) => e.event === "DISCLOSURE_REVOKED",
          ),
        );
      },
    );
    await t.test(
      "edited version settles only matching own request, chain and receipt; summary is narrow",
      async () => {
        const i = await make();
        await svc.edit(payer, i.id, 1, input);
        await svc.approve(payer, i.id, 2);
        const q = await svc.quote(payer, i.id);
        await svc.confirm(payer, i.id, 2, q.quote!.fingerprint);
        const ready = await svc.prepare(payer, i.id);
        await svc.submit(payer, i.id, hash(3));
        f.rpcControl.receipt = receiptFor(ready);
        f.rpcControl.chain = "mainnet";
        assert.equal((await svc.recheck(payer, i.id)).state, "UNKNOWN");
        f.rpcControl.chain = "testnet";
        const wrong = receiptFor(ready);
        wrong.transaction.actions[0]!.FunctionCall.args = Buffer.from(
          JSON.stringify({
            ...ready.quote!.request.actions[0].params.args,
            memo: randomUUID(),
          }),
        ).toString("base64");
        f.rpcControl.receipt = wrong;
        assert.equal((await svc.recheck(payer, i.id)).state, "REVIEW_REQUIRED");
        f.rpcControl.receipt = receiptFor(ready);
        assert.equal(
          (await svc.recheck(payer, i.id)).state,
          "VERIFIED_SUCCESS",
        );
        await svc.acknowledge(recipient, i.id);
        const g = await grant(i.id, 2, ["settlement"]);
        const d = await svc.disclosure(viewer, g.id);
        assert.equal((d.fields.settlement as any).verified, true);
        assert.equal((d.fields.settlement as any).recipientAcknowledged, true);
        for (const secret of [
          hash(3),
          ready.quote!.request.actions[0].params.args.memo,
          input.purpose,
          f.config.payer,
        ])
          assert.equal(JSON.stringify(d).includes(secret), false);
        const old = await grant(i.id, 1, ["settlement"]);
        assert.equal(
          (await svc.disclosure(viewer, old.id)).fields.settlement &&
            ((await svc.disclosure(viewer, old.id)).fields.settlement as any)
              .verified,
          false,
        );
        await assert.rejects(svc.edit(payer, i.id, 2, input), /PAYMENT_LOCKED/);
      },
    );
    await t.test(
      "SQL failure rolls back new version and encrypted grant metadata tampering fails",
      async () => {
        const i = await make();
        await pool.query(
          "CREATE FUNCTION fail_l1_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback fixture'; END $$; CREATE TRIGGER fail_l1_update BEFORE UPDATE ON l1_invoices FOR EACH ROW EXECUTE FUNCTION fail_l1_update()",
        );
        await assert.rejects(
          svc.edit(payer, i.id, 1, input),
          /rollback fixture/,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM l1_invoice_versions WHERE invoice_id=$1",
              [i.id],
            )
          ).rows[0].count,
          "1",
        );
        await assert.rejects(grant(i.id, 1, ["purpose"]), /rollback fixture/);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*) FROM l1_disclosures WHERE invoice_id=$1",
              [i.id],
            )
          ).rows[0].count,
          "0",
        );
        await pool.query(
          "DROP TRIGGER fail_l1_update ON l1_invoices; DROP FUNCTION fail_l1_update()",
        );
        const g = await grant(i.id, 1, ["purpose"]);
        await pool.query(
          "UPDATE l1_disclosures SET expires_at=expires_at+1 WHERE id=$1",
          [g.id],
        );
        await assert.rejects(
          svc.disclosure(viewer, g.id),
          /DISCLOSURE_BINDING_MISMATCH/,
        );
        const rows = await pool.query(
          "SELECT payload FROM l1_invoice_versions",
        );
        assert.ok(
          rows.rows.every(
            (r) => !r.payload.includes(Buffer.from(input.purpose)),
          ),
        );
      },
    );
    await t.test(
      "legacy v1 encrypted invoice backfills without losing prior data",
      async () => {
        const id = randomUUID(),
          legacy = {
            id,
            mode: "L1",
            version: 1,
            revision: 0,
            state: "CREATED",
            configTag: "",
            amountAtomic: "1",
            purpose: "legacy fake",
            createdAt: now,
          };
        const base = await make();
        const row = (
          await pool.query("SELECT payload FROM l1_invoices WHERE id=$1", [
            base.id,
          ])
        ).rows[0];
        legacy.configTag = unseal<any>(
          row.payload,
          key,
          "l1:" + base.id,
        ).configTag;
        await pool.query(
          "INSERT INTO l1_invoices(id,idempotency_tag,revision,payload) VALUES($1,$2,0,$3)",
          [id, randomBytes(32), seal(legacy, key, "l1:" + id)],
        );
        const got = await svc.get(payer, id);
        assert.equal(got.versions.length, 1);
        assert.equal(got.versions[0]!.payload.purpose, "legacy fake");
        await svc.edit(payer, id, 1, { amountAtomic: "2", purpose: "new" });
        assert.equal((await svc.get(payer, id)).versions.length, 2);
      },
    );
  } finally {
    await repo.close();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
