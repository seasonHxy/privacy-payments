import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdtempSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { L1Service } from "../../src/l1.js";
import { NearAuth } from "../../src/near-auth.js";
import { l1FixtureRpc } from "../helpers/l1-fixtures.js";
import { fakeConfig, hash, signingFixture } from "../helpers/near-fixtures.js";
const raw = process.env.TEST_DATABASE_URL;
if (!raw) throw Error("TEST_DATABASE_URL required");
const url = new URL(raw);
if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "55432" ||
  url.pathname !== "/privacy_payments" ||
  url.password !== "local-fake-data-only"
)
  throw Error("RESTORE_DRILL_REQUIRES_DISPOSABLE_LOCAL_FIXTURE_DATABASE");
test("real pg_dump/pg_restore into new local fixture database preserves encrypted versions, revoke and UNKNOWN; invalidates sessions", async () => {
  const suffix = randomBytes(6).toString("hex"),
    sourceName = "pp_src_" + suffix,
    destName = "pp_dst_" + suffix;
  const admin = new Pool({ connectionString: raw }),
    key = randomBytes(32),
    dir = mkdtempSync(join(tmpdir(), "pp-restore-fixture-"));
  chmodSync(dir, 0o700);
  const sourceUrl = new URL(raw);
  sourceUrl.pathname = "/" + sourceName;
  const destUrl = new URL(raw);
  destUrl.pathname = "/" + destName;
  let source: PostgresRepository | undefined,
    dest: PostgresRepository | undefined;
  const docker = (args: string[], input?: Buffer) =>
    execFileSync(
      "docker",
      ["exec", ...(input ? ["-i"] : []), "privacy-payments-postgres", ...args],
      { ...(input ? { input } : {}), maxBuffer: 20 * 1024 * 1024 },
    );
  try {
    await admin.query(`CREATE DATABASE ${sourceName} TEMPLATE template0`);
    await admin.query(`CREATE DATABASE ${destName} TEMPLATE template0`);
    source = new PostgresRepository(
      new Pool({ connectionString: sourceUrl.href }),
      key,
    );
    await source.migrate();
    const signer = signingFixture(),
      f = l1FixtureRpc(new Set(["payer-fixture.testnet|" + signer.publicKey]));
    const payer = { user: "payer" as const, accountId: f.config.payer },
      viewer = {
        user: "accountant" as const,
        accountId: "viewer-fixture.testnet",
      };
    const service = new L1Service(
      source.pool,
      key,
      f.config,
      f.rpc,
      undefined,
      viewer.accountId,
    );
    const created = await service.create(
      payer,
      {
        amountAtomic: "100",
        purpose: "restore fake",
        attachment: {
          name: "note.txt",
          type: "text/plain",
          content: "RESTORE_FAKE_ATTACHMENT",
        },
      },
      "restore-fixture-create",
    );
    await service.edit(payer, created.id, 1, {
      amountAtomic: "100",
      purpose: "restore fake v2",
    });
    const grant = await service.grant(payer, {
      invoiceId: created.id,
      version: 1,
      recipient: viewer.accountId,
      fields: ["attachment"],
      expiresAt: Date.now() + 60000,
    });
    await service.revoke(payer, grant.id);
    await service.approve(payer, created.id, 2);
    const q = await service.quote(payer, created.id);
    await service.confirm(payer, created.id, 2, q.quote!.fingerprint);
    await service.prepare(payer, created.id);
    await service.submit(payer, created.id, hash(3));
    f.rpcControl.receipt = { final_execution_status: "INCLUDED" };
    await service.recheck(payer, created.id);
    const auth = new NearAuth(source.pool, key, fakeConfig(), f.rpc),
      challenge = await auth.challenge(payer.accountId);
    const session = await auth.complete(
      {
        challengeId: challenge.challengeId,
        state: challenge.state,
        accountId: payer.accountId,
        publicKey: signer.publicKey,
        signature: signer.sign(challenge),
      },
      challenge.state,
    );
    const pending = await auth.challenge(payer.accountId);
    const migrationRows = (
      await source.pool.query(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    await source.close();
    source = undefined; // no application writer during snapshot
    writeFileSync(join(dir, "fixture-storage.key"), key, {
      mode: 0o600,
      flag: "wx",
    });
    const dump = docker([
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      sourceName,
      "--format=custom",
      "--no-owner",
      "--no-acl",
    ]);
    writeFileSync(join(dir, "database.partial"), dump, {
      mode: 0o600,
      flag: "wx",
    });
    assert.match(
      docker(["pg_restore", "--list"], dump).toString(),
      /l1_invoice_versions/,
    );
    const checksum = createHash("sha256").update(dump).digest("hex");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        checksum,
        migrations: migrationRows,
        keyId: createHash("sha256").update(key).digest("hex"),
      }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(join(dir, "database.partial"), join(dir, "database.dump"));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "database.dump")).mode & 0o777, 0o600);
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(dir, "database.dump")))
        .digest("hex"),
      checksum,
    );
    docker(
      [
        "pg_restore",
        "-U",
        "postgres",
        "-d",
        destName,
        "--exit-on-error",
        "--single-transaction",
        "--no-owner",
        "--no-acl",
      ],
      readFileSync(join(dir, "database.dump")),
    );
    const restoredKey = readFileSync(join(dir, "fixture-storage.key"));
    dest = new PostgresRepository(
      new Pool({ connectionString: destUrl.href }),
      restoredKey,
    );
    await dest.migrate();
    assert.deepEqual(
      (
        await dest.pool.query(
          "SELECT version,checksum FROM schema_migrations ORDER BY version",
        )
      ).rows,
      migrationRows,
    );
    // Restored authentication is never made live; invalidate both sessions and unused challenges first.
    await dest.pool.query(
      "UPDATE auth_sessions SET revoked_at=$1 WHERE revoked_at IS NULL",
      [Date.now()],
    );
    await dest.pool.query(
      "UPDATE auth_challenges SET consumed_at=$1 WHERE consumed_at IS NULL",
      [Date.now()],
    );
    const restored = new L1Service(
        dest.pool,
        restoredKey,
        f.config,
        f.rpc,
        undefined,
        viewer.accountId,
      ),
      got = await restored.get(payer, created.id);
    assert.equal(got.state, "UNKNOWN");
    assert.equal(got.version, 2);
    assert.equal(got.versions.length, 2);
    assert.equal(
      (await restored.attachment(payer, created.id, 1)).content,
      "RESTORE_FAKE_ATTACHMENT",
    );
    await assert.rejects(restored.disclosure(viewer, grant.id));
    await assert.rejects(restored.prepare(payer, created.id));
    await assert.rejects(
      restored.edit(payer, created.id, 2, {
        amountAtomic: "100",
        purpose: "must not retry",
      }),
    );
    await assert.rejects(
      new L1Service(dest.pool, randomBytes(32), f.config, f.rpc).get(
        payer,
        created.id,
      ),
    );
    const restoredAuth = new NearAuth(
      dest.pool,
      restoredKey,
      fakeConfig(),
      f.rpc,
    );
    await assert.rejects(restoredAuth.resolve(session.token));
    await assert.rejects(
      restoredAuth.complete(
        {
          challengeId: pending.challengeId,
          state: pending.state,
          accountId: payer.accountId,
          publicKey: signer.publicKey,
          signature: signer.sign(pending),
        },
        pending.state,
      ),
    );
  } finally {
    if (source) await source.close();
    if (dest) await dest.close();
    await admin.query(`DROP DATABASE IF EXISTS ${sourceName} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${destName} WITH (FORCE)`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
