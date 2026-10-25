import { Pool, type PoolClient } from "pg";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Service,
  Fault,
  check,
  fresh,
  members,
  seal,
  unseal,
  fingerprint,
  type State,
  type StateStore,
  type ServiceAPI,
  type User,
  type Invoice,
} from "./domain.js";

export type AsyncServiceAPI = {
  [K in keyof ServiceAPI]: (
    ...args: Parameters<ServiceAPI[K]>
  ) => Promise<Awaited<ReturnType<ServiceAPI[K]>>>;
};

class MemoryTransaction implements StateStore {
  constructor(public state: State) {}
  tx<T>(fn: (s: State) => T): T {
    const next = structuredClone(this.state);
    const result = fn(next);
    this.state = next;
    return result;
  }
}
export class PostgresRepository {
  constructor(
    public pool: Pool,
    private key: Buffer,
    public now = () => Date.now(),
  ) {
    check(key.length === 32, "INVALID_STORAGE_KEY", 500);
  }
  private context(table: string, id: string, workspace: string) {
    return `privacy-payments:pg:v1:${table}:${workspace}:${id}`;
  }
  private encrypt(
    table: string,
    id: string,
    workspace: string,
    value: unknown,
  ) {
    return seal(value, this.key, this.context(table, id, workspace));
  }
  private decrypt<T>(
    table: string,
    id: string,
    workspace: string,
    value: Buffer,
  ) {
    return unseal<T>(value, this.key, this.context(table, id, workspace));
  }
  private tag(kind: string, value: string) {
    return createHmac("sha256", this.key)
      .update(kind + "\0" + value)
      .digest();
  }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(72841001)");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const sql = await readFile(
        new URL("../migrations/001_relational.sql", import.meta.url),
        "utf8",
      );
      const hash = createHash("sha256").update(sql).digest("hex");
      const old = await client.query(
        "SELECT checksum FROM schema_migrations WHERE version=1",
      );
      if (old.rowCount)
        check(
          old.rows[0].checksum === hash,
          "MIGRATION_CHECKSUM_MISMATCH",
          500,
        );
      else {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)",
          [hash],
        );
      }
      for (const workspace of ["demo", "other"])
        await client.query(
          "INSERT INTO workspaces VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [
            workspace,
            "L0",
            this.encrypt("workspace", workspace, workspace, { mode: "L0" }),
          ],
        );
      for (const [user, m] of Object.entries(members))
        await client.query(
          "INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [m.workspace, user, m.role],
        );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  private async load(c: PoolClient, w: string): Promise<State> {
    const s = fresh();
    const invoices = await c.query(
      "SELECT * FROM invoices WHERE workspace_id=$1 ORDER BY id FOR UPDATE",
      [w],
    );
    s.invoices = invoices.rows.map((r) => {
      const decoded = this.decrypt<Omit<Invoice, "versions">>(
        "invoice",
        r.id,
        w,
        r.payload,
      );
      check(
        decoded.id === r.id &&
          decoded.workspace === w &&
          decoded.current === r.current_version &&
          decoded.settled === r.settled,
        "INVOICE_METADATA_MISMATCH",
        500,
      );
      return { ...decoded, versions: [] };
    });
    const versions = await c.query(
      "SELECT * FROM invoice_versions WHERE workspace_id=$1 ORDER BY version",
      [w],
    );
    for (const r of versions.rows)
      s.invoices
        .find((i) => i.id === r.invoice_id)!
        .versions.push(
          this.decrypt("version", `${r.invoice_id}:${r.version}`, w, r.payload),
        );
    for (const [table, target] of [
      ["approvals", "approvals"],
      ["payment_attempts", "attempts"],
      ["disclosure_grants", "grants"],
    ] as const) {
      const rows = await c.query(
        `SELECT * FROM ${table} WHERE workspace_id=$1 ORDER BY id`,
        [w],
      );
      (s[target] as unknown[]) = rows.rows.map((r) => {
        const decoded = this.decrypt<any>(table, r.id, w, r.payload);
        if (table === "payment_attempts") {
          check(
            decoded.revision === r.revision && decoded.state === r.state,
            "STATE_METADATA_MISMATCH",
            500,
          );
        }
        return decoded;
      });
    }
    const quotes = await c.query(
      "SELECT DISTINCT ON(attempt_id) * FROM quote_snapshots WHERE workspace_id=$1 ORDER BY attempt_id,revision DESC",
      [w],
    );
    for (const r of quotes.rows)
      s.attempts.find((a) => a.id === r.attempt_id)!.quote = this.decrypt(
        "quote",
        `${r.attempt_id}:${r.revision}`,
        w,
        r.payload,
      );
    const evidence = await c.query(
      "SELECT * FROM settlement_evidence WHERE workspace_id=$1",
      [w],
    );
    for (const r of evidence.rows)
      s.attempts.find((a) => a.id === r.attempt_id)!.evidence = this.decrypt(
        "evidence",
        r.attempt_id,
        w,
        r.payload,
      );
    const audit = await c.query(
      "SELECT * FROM audit_events WHERE workspace_id=$1 ORDER BY id",
      [w],
    );
    s.audit = audit.rows.map((r) =>
      this.decrypt("audit", String(r.id), w, r.payload),
    );
    return s;
  }
  private async save(c: PoolClient, w: string, before: State, after: State) {
    for (const i of after.invoices) {
      const { versions, ...head } = i;
      const old = before.invoices.find((x) => x.id === i.id);
      if (!old)
        await c.query("INSERT INTO invoices VALUES($1,$2,$3,$4,$5)", [
          i.id,
          w,
          i.current,
          i.settled,
          this.encrypt("invoice", i.id, w, head),
        ]);
      else if (
        fingerprint({ ...old, versions: [] }) !==
        fingerprint({ ...i, versions: [] })
      ) {
        const r = await c.query(
          "UPDATE invoices SET current_version=$1,settled=$2,payload=$3 WHERE id=$4 AND workspace_id=$5 AND current_version=$6",
          [
            i.current,
            i.settled,
            this.encrypt("invoice", i.id, w, head),
            i.id,
            w,
            old.current,
          ],
        );
        check(r.rowCount === 1, "VERSION_CONFLICT");
      }
      for (const v of versions) {
        const previous = old?.versions.find((x) => x.version === v.version);
        if (previous) {
          check(fingerprint(previous) === fingerprint(v), "IMMUTABLE_VERSION");
          continue;
        }
        await c.query("INSERT INTO invoice_versions VALUES($1,$2,$3,$4)", [
          w,
          i.id,
          v.version,
          this.encrypt("version", `${i.id}:${v.version}`, w, v),
        ]);
      }
    }
    for (const a of after.approvals) {
      const old = before.approvals.find((x) => x.id === a.id);
      if (old && fingerprint(old) === fingerprint(a)) continue;
      await c.query(
        "INSERT INTO approvals VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET active=EXCLUDED.active,payload=EXCLUDED.payload",
        [
          a.id,
          w,
          a.invoiceId,
          a.version,
          a.active,
          this.encrypt("approvals", a.id, w, a),
        ],
      );
    }
    for (const a of after.attempts) {
      const old = before.attempts.find((x) => x.id === a.id);
      const { quote, evidence, ...record } = a;
      if (!old)
        await c.query(
          "INSERT INTO payment_attempts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            a.id,
            w,
            a.invoiceId,
            a.version,
            a.approvalId,
            this.tag("idempotency:" + w, a.key),
            a.state,
            a.revision,
            this.encrypt("payment_attempts", a.id, w, record),
          ],
        );
      else if (fingerprint(a) !== fingerprint(old)) {
        const r = await c.query(
          "UPDATE payment_attempts SET state=$1,revision=$2,payload=$3 WHERE id=$4 AND workspace_id=$5 AND revision=$6",
          [
            a.state,
            a.revision,
            this.encrypt("payment_attempts", a.id, w, record),
            a.id,
            w,
            old.revision,
          ],
        );
        check(r.rowCount === 1, "STALE_VERIFICATION");
      }
      if (
        quote &&
        (!old?.quote || fingerprint(quote) !== fingerprint(old.quote))
      )
        await c.query("INSERT INTO quote_snapshots VALUES($1,$2,$3,$4)", [
          w,
          a.id,
          a.revision,
          this.encrypt("quote", `${a.id}:${a.revision}`, w, quote),
        ]);
      if (
        evidence &&
        (!old?.evidence || fingerprint(evidence) !== fingerprint(old.evidence))
      ) {
        if (old?.evidence)
          check(
            evidence.eventId === old.evidence.eventId,
            "EVIDENCE_ID_IMMUTABLE",
          );
        await c.query(
          "INSERT INTO settlement_evidence VALUES($1,$2,$3,$4) ON CONFLICT(attempt_id) DO UPDATE SET payload=EXCLUDED.payload",
          [
            a.id,
            w,
            this.tag("settlement-event", evidence.eventId),
            this.encrypt("evidence", a.id, w, evidence),
          ],
        );
      }
    }
    for (const g of after.grants) {
      const old = before.grants.find((x) => x.id === g.id);
      if (old && fingerprint(old) === fingerprint(g)) continue;
      await c.query(
        "INSERT INTO disclosure_grants VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload",
        [
          g.id,
          w,
          g.invoiceId,
          g.version,
          g.recipient,
          this.encrypt("disclosure_grants", g.id, w, g),
        ],
      );
    }
    for (const event of after.audit.slice(before.audit.length)) {
      const sequence = await c.query(
        "SELECT nextval(pg_get_serial_sequence('audit_events','id')) AS id",
      );
      const id = String(sequence.rows[0].id);
      await c.query(
        "INSERT INTO audit_events(id,workspace_id,payload) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3)",
        [id, w, this.encrypt("audit", id, w, event)],
      );
    }
  }
  async run(method: string, args: unknown[]) {
    if (method === "recover") {
      const rows = await this.pool.query(
        "SELECT id,revision FROM payment_attempts WHERE state IN ('SUBMITTED','VERIFYING')",
      );
      for (const r of rows.rows)
        try {
          await this.run("verify", [r.id, r.revision]);
        } catch (e) {
          if (!(e instanceof Fault && e.code === "STALE_VERIFICATION")) throw e;
        }
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      let workspace: string;
      if (method === "verify") {
        const r = await client.query(
          "SELECT workspace_id FROM payment_attempts WHERE id=$1",
          [args[0]],
        );
        check(r.rowCount, "NOT_FOUND", 404);
        workspace = r.rows[0].workspace_id;
      } else {
        const u = args[0] as User;
        check(members[u], "UNAUTHENTICATED", 401);
        workspace = members[u].workspace;
        const membership = await client.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [workspace, u],
        );
        check(
          membership.rows[0]?.role === members[u].role,
          "MEMBERSHIP_REQUIRED",
          403,
        );
      }
      // One workspace row serializes a small team's mutations; invoice rows also lock below.
      const lock = await client.query(
        "SELECT mode,payload FROM workspaces WHERE id=$1 FOR UPDATE",
        [workspace],
      );
      check(lock.rows[0]?.mode === "L0", "REAL_MODES_DISABLED", 503);
      this.decrypt("workspace", workspace, workspace, lock.rows[0].payload);
      const before = await this.load(client, workspace);
      const memory = new MemoryTransaction(structuredClone(before));
      const service = new Service(memory, this.now);
      const fn = (
        service as unknown as Record<string, (...args: unknown[]) => unknown>
      )[method];
      check(
        typeof fn === "function" && publicMethods.includes(method),
        "UNKNOWN_OPERATION",
        400,
      );
      const result = fn.apply(service, args);
      await this.save(client, workspace, before, memory.state);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      if ((e as any).code === "23505")
        throw new Fault(409, "DATABASE_UNIQUENESS_CONFLICT");
      throw e;
    } finally {
      client.release();
    }
  }
  api(): AsyncServiceAPI {
    const object: Record<string, unknown> = { now: async () => this.now() };
    for (const method of publicMethods)
      object[method] = (...args: unknown[]) => this.run(method, args);
    return object as AsyncServiceAPI;
  }
  async close() {
    await this.pool.end();
  }
}
const publicMethods = [
  "list",
  "get",
  "create",
  "edit",
  "approve",
  "start",
  "quote",
  "confirm",
  "prepare",
  "submit",
  "reject",
  "status",
  "verify",
  "recover",
  "acknowledge",
  "grant",
  "grants",
  "disclosure",
  "revoke",
];
