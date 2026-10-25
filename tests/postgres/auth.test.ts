import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { NearAuth, authConfigSchema } from "../../src/near-auth.js";
import { NearReadOnlyRpc } from "../../src/near-rpc.js";
import { createApp } from "../../src/server.js";
import {
  fakeConfig,
  mockRpc,
  signingFixture,
  hash,
} from "../helpers/near-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
test("persistent NEP-413 auth with real PostgreSQL and mock-only RPC", async (t) => {
  const schema = "pna_" + randomBytes(8).toString("hex"),
    root = new Pool({ connectionString: url });
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    }),
    key = randomBytes(32),
    repo = new PostgresRepository(pool, key);
  await repo.migrate();
  const config = fakeConfig(),
    payer = signingFixture(),
    viewer = signingFixture(),
    allowed = new Set([
      "payer-fixture.testnet|" + payer.publicKey,
      "viewer-fixture.testnet|" + viewer.publicKey,
    ]),
    { fetcher, control } = mockRpc(allowed);
  let now = Date.now();
  const rpc = new NearReadOnlyRpc(
    {
      url: config.rpcUrl,
      chainId: config.chainId,
      genesisHash: config.genesisHash,
    },
    fetcher,
  );
  let auth = new NearAuth(pool, key, config, rpc, () => now);
  async function proof(accountId = "payer-fixture.testnet", fixture = payer) {
    const c = await auth.challenge(accountId);
    return {
      c,
      b: {
        challengeId: c.challengeId,
        accountId,
        publicKey: fixture.publicKey,
        signature: fixture.sign(c),
        state: c.state,
      },
    };
  }
  try {
    await t.test(
      "missing/unsafe config and arbitrary account mapping rejected",
      async () => {
        assert.throws(() => authConfigSchema.parse({}));
        assert.throws(() => authConfigSchema.parse({ ...config, members: {} }));
        assert.throws(
          () =>
            new NearReadOnlyRpc({
              url: "http://evil.example",
              chainId: "testnet",
              genesisHash: hash(1),
            }),
        );
        await assert.rejects(auth.challenge("unknown-fixture.testnet"));
        const before = Number(
          (await pool.query("SELECT count(*) n FROM auth_challenges")).rows[0]
            .n,
        );
        await assert.rejects(auth.challenge("constructor"));
        assert.equal(
          Number(
            (await pool.query("SELECT count(*) n FROM auth_challenges")).rows[0]
              .n,
          ),
          before,
        );
        assert.throws(() =>
          createApp(repo.api(), "https://wrong.example", auth),
        );
      },
    );
    await t.test(
      "six concurrent consumes create exactly one session; persistence and replay",
      async () => {
        const { c, b } = await proof();
        auth = new NearAuth(pool, key, config, rpc, () => now);
        const before = Number(
          (await pool.query("SELECT count(*) n FROM auth_sessions")).rows[0].n,
        );
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () => auth.complete(b, c.state)),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(results.filter((r) => r.status === "rejected").length, 5);
        assert.equal(
          Number(
            (await pool.query("SELECT count(*) n FROM auth_sessions")).rows[0]
              .n,
          ),
          before + 1,
        );
        await assert.rejects(auth.complete(b, c.state));
        const row = (
          await pool.query("SELECT * FROM auth_challenges WHERE id=$1", [
            c.challengeId,
          ])
        ).rows[0];
        assert.ok(row.consumed_at);
        assert.equal(row.payload.includes(Buffer.from(c.message)), false);
        assert.equal(row.payload.includes(Buffer.from(c.nonceBase64)), false);
      },
    );
    await t.test(
      "wrong browser state/domain/account, client role and invalid signatures never consume nonce",
      async () => {
        const { c, b } = await proof();
        await assert.rejects(auth.complete(b, "x".repeat(43)));
        await assert.rejects(
          auth.complete({ ...b, accountId: "viewer-fixture.testnet" }, c.state),
        );
        await assert.rejects(auth.complete({ ...b, role: "admin" }, c.state));
        await assert.rejects(
          auth.complete(
            {
              ...b,
              signature: payer.sign({
                ...c,
                recipient: "https://evil.example",
              }),
            },
            c.state,
          ),
        );
        await assert.rejects(
          auth.complete(
            { ...b, signature: Buffer.alloc(64).toString("base64") },
            c.state,
          ),
        );
        assert.equal(
          (
            await pool.query(
              "SELECT consumed_at FROM auth_challenges WHERE id=$1",
              [c.challengeId],
            )
          ).rows[0].consumed_at,
          null,
        );
        const ok = await auth.complete(b, c.state);
        assert.equal((await auth.resolve(ok.token)).user, "payer");
      },
    );
    await t.test(
      "expiration, wrong chain/genesis, FunctionCall and removed keys fail closed",
      async () => {
        const { c, b } = await proof();
        const original = now;
        now = c.expiresAt;
        await assert.rejects(auth.complete(b, c.state));
        now = original;
        const q = await proof();
        control.chain = "mainnet";
        await assert.rejects(auth.complete(q.b, q.c.state));
        control.chain = "testnet";
        control.genesis = hash(9);
        await assert.rejects(auth.complete(q.b, q.c.state));
        control.genesis = config.genesisHash;
        control.permission = { FunctionCall: {} };
        await assert.rejects(auth.complete(q.b, q.c.state));
        control.permission = "FullAccess";
        allowed.delete("payer-fixture.testnet|" + payer.publicKey);
        await assert.rejects(auth.complete(q.b, q.c.state));
        allowed.add("payer-fixture.testnet|" + payer.publicKey);
        assert.equal(
          (
            await pool.query(
              "SELECT consumed_at FROM auth_challenges WHERE id=$1",
              [q.c.challengeId],
            )
          ).rows[0].consumed_at,
          null,
        );
      },
    );
    await t.test(
      "sessions rotate, logout, mapping changes and key revocation take effect",
      async () => {
        const { c, b } = await proof();
        const session = await auth.complete(b, c.state, "A".repeat(43));
        assert.notEqual(session.token, "A".repeat(43));
        await auth.resolve(session.token);
        allowed.delete("payer-fixture.testnet|" + payer.publicKey);
        await assert.rejects(auth.resolve(session.token));
        allowed.add("payer-fixture.testnet|" + payer.publicKey);
        const altered = new NearAuth(
          pool,
          key,
          { ...config, members: { "payer-fixture.testnet": "admin" } },
          rpc,
          () => now,
        );
        await assert.rejects(altered.resolve(session.token));
        const rotated = await auth.rotate(session.token);
        assert.notEqual(rotated.token, session.token);
        await assert.rejects(auth.resolve(session.token));
        await auth.resolve(rotated.token);
        await auth.logout(rotated.token);
        await assert.rejects(auth.resolve(rotated.token));
      },
    );
    await t.test(
      "session expiry metadata is authenticated; failed insert rolls back nonce consume",
      async () => {
        const { c, b } = await proof();
        await pool.query(
          "CREATE FUNCTION fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$; CREATE TRIGGER fail_session_insert BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fail_session()",
        );
        await assert.rejects(auth.complete(b, c.state));
        assert.equal(
          (
            await pool.query(
              "SELECT consumed_at FROM auth_challenges WHERE id=$1",
              [c.challengeId],
            )
          ).rows[0].consumed_at,
          null,
        );
        await pool.query(
          "DROP TRIGGER fail_session_insert ON auth_sessions; DROP FUNCTION fail_session()",
        );
        const session = await auth.complete(b, c.state);
        await pool.query(
          "UPDATE auth_sessions SET expires_at=expires_at+1 WHERE expires_at=$1 AND revoked_at IS NULL",
          [session.expiresAt],
        );
        await assert.rejects(auth.resolve(session.token));
      },
    );
    await t.test(
      "concurrent rotation has one winner; logout during RPC cannot resurrect session",
      async () => {
        const p = await proof(),
          session = await auth.complete(p.b, p.c.state);
        const results = await Promise.allSettled(
          Array.from({ length: 4 }, () => auth.rotate(session.token)),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(results.filter((r) => r.status === "rejected").length, 3);
        const current = (
          results.find(
            (r) => r.status === "fulfilled",
          ) as PromiseFulfilledResult<{ token: string }>
        ).value;
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>((r) => (entered = r)),
          gate = new Promise<void>((r) => (release = r));
        const blocked: typeof fetch = async (url, init) => {
          const body = JSON.parse(init!.body as string);
          if (body.method === "query") {
            entered();
            await gate;
          }
          return fetcher(url, init);
        };
        const gatedAuth = new NearAuth(
          pool,
          key,
          config,
          new NearReadOnlyRpc(
            {
              url: config.rpcUrl,
              chainId: config.chainId,
              genesisHash: config.genesisHash,
            },
            blocked,
          ),
          () => now,
        );
        const pending = gatedAuth.resolve(current.token);
        await waiting;
        await auth.logout(current.token);
        release();
        await assert.rejects(pending);
      },
    );
    await t.test(
      "HTTP real-auth mode disables demo, ignores demo cookies and enforces configured viewer role",
      async () => {
        const server = createApp(repo.api(), config.origin, auth).listen(
          0,
          "127.0.0.1",
        );
        await new Promise<void>((r) => server.once("listening", r));
        const base = `http://127.0.0.1:${(server.address() as any).port}`;
        const send = (
          path: string,
          body: unknown,
          cookie = "",
          origin = config.origin,
        ) =>
          fetch(base + "/api" + path, {
            method: "POST",
            headers: {
              Origin: origin,
              "Content-Type": "application/json",
              Cookie: cookie,
            },
            body: JSON.stringify(body),
          });
        try {
          assert.equal(
            (await send("/demo/session", { user: "payer" })).status,
            403,
          );
          assert.equal(
            (
              await fetch(base + "/api/me", {
                headers: { Cookie: "session=fixed-demo-token" },
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await send(
                "/auth/challenge",
                { accountId: "viewer-fixture.testnet" },
                "",
                "https://evil.example",
              )
            ).status,
            403,
          );
          const response = await send("/auth/challenge", {
            accountId: "viewer-fixture.testnet",
          });
          const c = await response.json();
          const challengeCookie = response.headers
            .get("set-cookie")!
            .split(";")[0]!;
          const verify = await send(
            "/auth/verify",
            {
              challengeId: c.challengeId,
              accountId: c.accountId,
              publicKey: viewer.publicKey,
              signature: viewer.sign(c),
              state: c.state,
            },
            challengeCookie + "; near_session=" + "A".repeat(43),
          );
          assert.equal(verify.status, 200);
          assert.equal((await verify.json()).user, "accountant");
          const sessionCookie = verify.headers
            .getSetCookie()
            .find((v) => v.startsWith("near_session="))!
            .split(";")[0]!;
          assert.ok(!sessionCookie.endsWith("A".repeat(43)));
          const me = await fetch(base + "/api/me", {
            headers: { Cookie: sessionCookie },
          });
          assert.equal((await me.json()).role, "viewer");
          assert.equal(
            (await send("/invoices", {}, sessionCookie)).status,
            403,
          );
          const rotation = await send("/auth/rotate", {}, sessionCookie);
          assert.equal(rotation.status, 200);
          assert.equal(
            (
              await fetch(base + "/api/me", {
                headers: { Cookie: sessionCookie },
              })
            ).status,
            401,
          );
          const next = rotation.headers.get("set-cookie")!.split(";")[0]!;
          await send("/auth/logout", {}, next);
          assert.equal(
            (await fetch(base + "/api/me", { headers: { Cookie: next } }))
              .status,
            401,
          );
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
