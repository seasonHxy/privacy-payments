import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const NOTICE = "模拟，无真实资金移动";
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function check(
  value: unknown,
  code: string,
  status = 409,
): asserts value {
  if (!value) throw new Fault(status, code);
}
export const members = {
  payer: { workspace: "demo", role: "payer" },
  admin: { workspace: "demo", role: "admin" },
  accountant: { workspace: "demo", role: "viewer" },
  recipient: { workspace: "demo", role: "recipient" },
  outsider: { workspace: "other", role: "payer" },
  otherRecipient: { workspace: "demo", role: "recipient" },
} as const;
export type User = keyof typeof members;
export const asset = {
  id: "mock:USD",
  network: "mock-local",
  decimals: 6,
  symbol: "模拟 USD",
};
export const amount = z.string().regex(/^[1-9][0-9]{0,77}$/);
const attachmentSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}_. -]+$/u),
    type: z.literal("text/plain"),
    content: z
      .string()
      .max(65536)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 65536),
  })
  .strict();
export const payloadSchema = z
  .object({
    amountAtomic: amount,
    asset: z.literal("mock:USD"),
    network: z.literal("mock-local"),
    recipient: z.literal("recipient"),
    address: z.string().regex(/^demo:[a-z0-9-]{1,40}$/),
    purpose: z.string().min(1).max(500),
    attachment: attachmentSchema.optional(),
  })
  .strict();
export type Payload = z.infer<typeof payloadSchema>;
type Version = {
  version: number;
  payload: Payload;
  fingerprint: string;
  createdAt: number;
};
type Invoice = {
  id: string;
  workspace: string;
  creator: User;
  current: number;
  mode: "L0";
  settled: boolean;
  versions: Version[];
};
type Approval = {
  id: string;
  invoiceId: string;
  version: number;
  by: User;
  at: number;
  active: boolean;
};
export type Status =
  | "CREATED"
  | "QUOTED"
  | "AWAITING_SIGNATURE"
  | "SUBMITTED"
  | "VERIFYING"
  | "VERIFIED_SUCCESS"
  | "USER_REJECTED"
  | "UNKNOWN"
  | "FAILED_NO_TRANSFER"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REVIEW_REQUIRED";
export type Quote = {
  invoiceFingerprint: string;
  mode: "L0";
  network: string;
  asset: string;
  recipient: string;
  refundTo: string;
  inputAtomic: string;
  outputAtomic: string;
  networkFeeAtomic: string;
  serviceFeeAtomic: string;
  expiresAt: number;
  refundPolicy: string;
  fingerprint: string;
};
type Evidence = {
  source: string;
  eventId: string;
  mode: string;
  network: string;
  asset: string;
  payer: string;
  recipient: string;
  amountAtomic: string;
  final: boolean;
  success: boolean;
  receivedAcknowledged?: boolean;
};
type Attempt = {
  id: string;
  invoiceId: string;
  workspace: string;
  version: number;
  approvalId: string;
  key: string;
  params: string;
  state: Status;
  revision: number;
  quote?: Quote;
  reference?: string;
  evidence?: Evidence;
  reason?: string;
};
type Grant = {
  id: string;
  invoiceId: string;
  version: number;
  recipient: "accountant";
  fields: string[];
  expiresAt: number;
  revokedAt?: number;
};
type State = {
  invoices: Invoice[];
  approvals: Approval[];
  attempts: Attempt[];
  grants: Grant[];
  audit: { by: User; object: string; type: string; at: number }[];
};
const fresh = (): State => ({
  invoices: [],
  approvals: [],
  attempts: [],
  grants: [],
  audit: [],
});
const canonical = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(",")}]`
    : x !== null && typeof x === "object"
      ? `{${Object.keys(x)
          .sort()
          .map(
            (k) =>
              `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`
      : JSON.stringify(x);
export const fingerprint = (x: unknown) =>
  createHash("sha256").update(canonical(x)).digest("hex");
export function seal(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("privacy-payments:state:v1"));
  const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function unseal(value: Buffer, key: Buffer): State {
  const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  c.setAAD(Buffer.from("privacy-payments:state:v1"));
  c.setAuthTag(value.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(),
  );
}
export class Store {
  db: DatabaseSync;
  constructor(
    path: string,
    private key: Buffer,
  ) {
    check(key.length === 32, "INVALID_STORAGE_KEY", 500);
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO state VALUES (1,?)")
      .run(seal(fresh(), key));
  }
  tx<T>(fn: (s: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT payload FROM state WHERE id=1")
        .get()!;
      const s = unseal(Buffer.from(row.payload as Uint8Array), this.key);
      const out = fn(s);
      this.db
        .prepare("UPDATE state SET payload=? WHERE id=1")
        .run(seal(s, this.key));
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
const inactive: Status[] = ["USER_REJECTED", "FAILED_NO_TRANSFER"];
export class Service {
  constructor(
    public store: Store,
    public now = () => Date.now(),
  ) {}
  private payer(u: User) {
    check(members[u]?.role === "payer", "PAYER_REQUIRED", 403);
  }
  private invoice(s: State, u: User, id: string, write = false) {
    const i = s.invoices.find(
      (x) => x.id === id && x.workspace === members[u]?.workspace,
    );
    check(i, "NOT_FOUND", 404);
    if (write) this.payer(u);
    else
      check(
        members[u].role === "payer" ||
          (members[u].role === "recipient" &&
            i.versions[i.current - 1]!.payload.recipient === u),
        "OBJECT_FORBIDDEN",
        403,
      );
    return i;
  }
  private attempt(s: State, u: User, id: string) {
    const a = s.attempts.find((x) => x.id === id);
    check(a, "NOT_FOUND", 404);
    const i = this.invoice(s, u, a.invoiceId, true);
    return { a, i };
  }
  private audit(s: State, u: User, id: string, type: string) {
    s.audit.push({ by: u, object: id, type, at: this.now() });
  }
  private transition(a: Attempt, state: Status) {
    a.state = state;
    a.revision++;
  }
  private validQuote(a: Attempt, i: Invoice) {
    check(a.quote, "QUOTE_REQUIRED");
    check(a.quote.expiresAt > this.now(), "QUOTE_EXPIRED");
    check(
      i.current === a.version &&
        a.quote.invoiceFingerprint === i.versions[i.current - 1]!.fingerprint,
      "VERSION_CONFLICT",
    );
  }
  list(u: User) {
    return this.store.tx((s) =>
      s.invoices
        .filter(
          (i) =>
            i.workspace === members[u]?.workspace &&
            (members[u].role === "payer" ||
              i.versions[i.current - 1]!.payload.recipient === u),
        )
        .map((i) => ({
          id: i.id,
          version: i.current,
          settled: i.settled,
          payload: i.versions[i.current - 1]!.payload,
          notice: NOTICE,
        })),
    );
  }
  get(u: User, id: string) {
    return this.store.tx((s) => {
      const i = this.invoice(s, u, id);
      return {
        ...i,
        approvals: s.approvals.filter((a) => a.invoiceId === id),
        attempts: s.attempts.filter((a) => a.invoiceId === id),
        notice: NOTICE,
      };
    });
  }
  create(u: User, input: unknown) {
    this.payer(u);
    const payload = payloadSchema.parse(input);
    return this.store.tx((s) => {
      const id = randomUUID();
      const i: Invoice = {
        id,
        workspace: members[u].workspace,
        creator: u,
        current: 1,
        mode: "L0",
        settled: false,
        versions: [
          {
            version: 1,
            payload,
            fingerprint: fingerprint(payload),
            createdAt: this.now(),
          },
        ],
      };
      s.invoices.push(i);
      this.audit(s, u, id, "INVOICE_CREATED");
      return { invoiceId: id, version: 1, notice: NOTICE };
    });
  }
  edit(u: User, id: string, expectedVersion: number, input: unknown) {
    const payload = payloadSchema.parse(input);
    return this.store.tx((s) => {
      const i = this.invoice(s, u, id, true);
      check(i.current === expectedVersion, "VERSION_CONFLICT");
      check(!i.settled, "ALREADY_SETTLED");
      const active = s.attempts.filter(
        (a) => a.invoiceId === id && !inactive.includes(a.state),
      );
      check(
        active.every((a) => ["CREATED", "QUOTED"].includes(a.state)),
        "PAYMENT_LOCKED",
      );
      for (const a of active) {
        this.transition(a, "FAILED_NO_TRANSFER");
        a.reason = "VERSION_REPLACED_BEFORE_SIGNING";
      }
      s.approvals
        .filter((a) => a.invoiceId === id)
        .forEach((a) => (a.active = false));
      i.current++;
      i.versions.push({
        version: i.current,
        payload,
        fingerprint: fingerprint(payload),
        createdAt: this.now(),
      });
      this.audit(s, u, id, "VERSION_CREATED");
      return { invoiceId: id, version: i.current };
    });
  }
  approve(u: User, id: string, version: number) {
    return this.store.tx((s) => {
      const i = this.invoice(s, u, id, true);
      check(i.current === version && !i.settled, "VERSION_CONFLICT");
      let approval = s.approvals.find(
        (a) => a.invoiceId === id && a.version === version && a.active,
      );
      if (!approval) {
        approval = {
          id: randomUUID(),
          invoiceId: id,
          version,
          by: u,
          at: this.now(),
          active: true,
        };
        s.approvals.push(approval);
        this.audit(s, u, id, "APPROVED");
      }
      return approval;
    });
  }
  start(u: User, id: string, version: number, key: string, mode = "L0") {
    check(/^[a-zA-Z0-9_-]{8,100}$/.test(key), "INVALID_IDEMPOTENCY_KEY", 400);
    return this.store.tx((s) => {
      const i = this.invoice(s, u, id, true);
      const params = fingerprint({ id, version, mode });
      const old = s.attempts.find(
        (a) => a.workspace === i.workspace && a.key === key,
      );
      if (old) {
        check(old.params === params, "IDEMPOTENCY_CONFLICT");
        return old;
      }
      check(mode === "L0", "CHANNEL_DISABLED", 503);
      check(!i.settled, "ALREADY_SETTLED");
      check(i.current === version, "VERSION_CONFLICT");
      const ap = s.approvals.find(
        (a) => a.invoiceId === id && a.version === version && a.active,
      );
      check(ap, "APPROVAL_REQUIRED");
      check(
        !s.attempts.some(
          (a) => a.invoiceId === id && !inactive.includes(a.state),
        ),
        "ACTIVE_ATTEMPT_EXISTS",
      );
      const a: Attempt = {
        id: randomUUID(),
        invoiceId: id,
        workspace: i.workspace,
        version,
        approvalId: ap.id,
        key,
        params,
        state: "CREATED",
        revision: 0,
      };
      s.attempts.push(a);
      this.audit(s, u, id, "ATTEMPT_CREATED");
      return a;
    });
  }
  quote(u: User, id: string) {
    return this.store.tx((s) => {
      const { a, i } = this.attempt(s, u, id);
      check(["CREATED", "QUOTED"].includes(a.state), "INVALID_STATE");
      const p = i.versions[a.version - 1]!.payload;
      check(
        BigInt(p.amountAtomic) + 100n < 10n ** 78n,
        "INPUT_LIMIT_EXCEEDED",
        400,
      );
      const q = {
        invoiceFingerprint: i.versions[a.version - 1]!.fingerprint,
        mode: "L0" as const,
        network: p.network,
        asset: p.asset,
        recipient: p.address,
        refundTo: "demo:payer",
        inputAtomic: (BigInt(p.amountAtomic) + 100n).toString(),
        outputAtomic: p.amountAtomic,
        networkFeeAtomic: "0",
        serviceFeeAtomic: "100",
        expiresAt: this.now() + 120000,
        refundPolicy:
          "模拟通道不执行退款；退款必须另行核验，不能凭状态字符串确认。",
      };
      a.quote = { ...q, fingerprint: fingerprint(q) };
      this.transition(a, "QUOTED");
      return a;
    });
  }
  confirm(u: User, id: string, version: number, binding: string) {
    return this.store.tx((s) => {
      const { a, i } = this.attempt(s, u, id);
      check(a.state === "QUOTED", "INVALID_STATE");
      this.validQuote(a, i);
      check(
        version === a.version && binding === a.quote!.fingerprint,
        "QUOTE_BINDING_MISMATCH",
      );
      this.transition(a, "AWAITING_SIGNATURE");
      this.audit(s, u, id, "QUOTE_CONFIRMED");
      return a;
    });
  }
  prepare(u: User, id: string) {
    return this.store.tx((s) => {
      const { a, i } = this.attempt(s, u, id);
      check(a.state === "AWAITING_SIGNATURE", "INVALID_STATE");
      this.validQuote(a, i);
      return {
        mode: "L0",
        notice: NOTICE,
        type: "SIMULATION_ONLY",
        quoteFingerprint: a.quote!.fingerprint,
        conditions: a.quote,
        walletRequest: null,
      };
    });
  }
  submit(u: User, id: string, reference: string) {
    return this.store.tx((s) => {
      const { a, i } = this.attempt(s, u, id);
      if (a.reference) {
        check(a.reference === reference, "REFERENCE_CONFLICT");
        return a;
      }
      check(a.state === "AWAITING_SIGNATURE", "INVALID_STATE");
      this.validQuote(a, i);
      check(
        [
          "sim:success",
          "sim:timeout",
          "sim:underpaid",
          "sim:failed",
          "sim:refund-partial",
        ].includes(reference),
        "SIM_REFERENCE_REQUIRED",
        400,
      );
      a.reference = reference;
      this.transition(a, "SUBMITTED");
      this.audit(s, u, id, "REFERENCE_RECORDED");
      return a;
    });
  }
  reject(u: User, id: string) {
    return this.store.tx((s) => {
      const { a } = this.attempt(s, u, id);
      check(a.state === "AWAITING_SIGNATURE" && !a.reference, "INVALID_STATE");
      this.transition(a, "USER_REJECTED");
      return a;
    });
  }
  status(u: User, id: string) {
    return this.store.tx((s) => this.attempt(s, u, id).a);
  }
  // Read-only verifier of execution: never constructs, signs or broadcasts transactions.
  verify(id: string) {
    return this.store.tx((s) => {
      const a = s.attempts.find((x) => x.id === id);
      check(a, "NOT_FOUND", 404);
      if (!["SUBMITTED", "VERIFYING", "UNKNOWN"].includes(a.state)) return a;
      const expected = a.revision;
      const i = s.invoices.find((x) => x.id === a.invoiceId)!;
      const q = a.quote!;
      const ref = a.reference;
      check(a.revision === expected, "STALE_VERIFICATION");
      if (ref === "sim:timeout") {
        this.transition(a, "UNKNOWN");
        a.reason = "NO_FINAL_EVIDENCE";
        return a;
      }
      if (ref === "sim:failed") {
        this.transition(a, "FAILED_NO_TRANSFER");
        a.reason = "SIMULATOR_CONFIRMS_NO_TRANSFER";
        return a;
      }
      const e: Evidence = {
        source: "local-simulator",
        mode: "L0",
        eventId: `mock:${a.id}`,
        network: q.network,
        asset: q.asset,
        payer: "demo:payer",
        recipient: q.recipient,
        amountAtomic: ref === "sim:underpaid" ? "1" : q.outputAtomic,
        final: true,
        success: true,
      };
      a.evidence = e;
      check(
        !s.attempts.some(
          (other) => other.id !== a.id && other.evidence?.eventId === e.eventId,
        ),
        "EVIDENCE_ALREADY_ASSIGNED",
      );
      this.transition(a, "VERIFYING");
      if (ref === "sim:refund-partial") {
        this.transition(a, "REVIEW_REQUIRED");
        a.reason = "PARTIAL_REFUND_NOT_SETTLED";
        return a;
      }
      if (!matchesSettlement(e, q, i.mode)) {
        this.transition(a, "REVIEW_REQUIRED");
        a.reason = "SETTLEMENT_MISMATCH";
        return a;
      }
      this.transition(a, "VERIFIED_SUCCESS");
      i.settled = true;
      this.audit(s, "payer", a.id, "SIMULATED_SETTLEMENT_VERIFIED");
      return a;
    });
  }
  recover() {
    const ids = this.store.tx((s) =>
      s.attempts
        .filter((a) => ["SUBMITTED", "VERIFYING"].includes(a.state))
        .map((a) => a.id),
    );
    ids.forEach((id) => this.verify(id));
  }
  acknowledge(u: User, id: string) {
    return this.store.tx((s) => {
      const i = this.invoice(s, u, id);
      check(u === "recipient", "RECIPIENT_REQUIRED", 403);
      const a = s.attempts.find(
        (a) => a.invoiceId === i.id && a.state === "VERIFIED_SUCCESS",
      );
      check(a?.evidence, "VERIFIED_EVIDENCE_REQUIRED");
      a.evidence.receivedAcknowledged = true;
      this.audit(s, u, id, "RECIPIENT_ACKNOWLEDGED_SIMULATION");
      return { notice: NOTICE, acknowledged: true };
    });
  }
  grant(u: User, input: unknown) {
    const b = z
      .object({
        invoiceId: z.string(),
        version: z.number().int(),
        recipient: z.literal("accountant"),
        fields: z
          .array(
            z.enum([
              "amountAtomic",
              "asset",
              "network",
              "purpose",
              "address",
              "evidence",
            ]),
          )
          .min(1)
          .max(6),
        expiresAt: z.number().int(),
      })
      .strict()
      .parse(input);
    return this.store.tx((s) => {
      const i = this.invoice(s, u, b.invoiceId, true);
      check(
        i.versions.some((v) => v.version === b.version),
        "VERSION_CONFLICT",
      );
      check(
        b.expiresAt > this.now() && b.expiresAt <= this.now() + 30 * 86400000,
        "INVALID_EXPIRY",
        400,
      );
      const g = { ...b, id: randomUUID() };
      s.grants.push(g);
      this.audit(s, u, g.id, "DISCLOSURE_GRANTED");
      return g;
    });
  }
  grants(u: User) {
    return this.store.tx((s) =>
      s.grants
        .filter((g) => {
          const i = s.invoices.find((i) => i.id === g.invoiceId)!;
          return (
            i.workspace === members[u]?.workspace &&
            (u === "payer" || g.recipient === u)
          );
        })
        .map((g) => ({ ...g, notice: NOTICE })),
    );
  }
  disclosure(u: User, id: string) {
    return this.store.tx((s) => {
      const g = s.grants.find((x) => x.id === id);
      check(g, "NOT_FOUND", 404);
      const i = s.invoices.find((x) => x.id === g.invoiceId)!;
      check(
        i.workspace === members[u]?.workspace && g.recipient === u,
        "DISCLOSURE_FORBIDDEN",
        403,
      );
      check(
        !g.revokedAt && g.expiresAt > this.now(),
        "DISCLOSURE_EXPIRED_OR_REVOKED",
        403,
      );
      const p = i.versions[g.version - 1]!.payload;
      const out: Record<string, unknown> = {
        notice: NOTICE,
        mode: "L0",
        invoiceId: i.id,
        version: g.version,
      };
      for (const f of g.fields) {
        if (f === "evidence") {
          const e = s.attempts.find(
            (a) =>
              a.invoiceId === i.id &&
              a.version === g.version &&
              a.state === "VERIFIED_SUCCESS",
          )?.evidence;
          out.evidence = e
            ? {
                source: e.source,
                final: e.final,
                success: e.success,
                receivedAcknowledged: !!e.receivedAcknowledged,
              }
            : null;
        } else out[f] = p[f as keyof Payload];
      }
      this.audit(s, u, id, "DISCLOSURE_READ");
      return out;
    });
  }
  revoke(u: User, id: string) {
    return this.store.tx((s) => {
      const g = s.grants.find((x) => x.id === id);
      check(g, "NOT_FOUND", 404);
      this.invoice(s, u, g.invoiceId, true);
      g.revokedAt = this.now();
      this.audit(s, u, id, "DISCLOSURE_REVOKED");
      return { revoked: true };
    });
  }
}
export function matchesSettlement(e: Evidence, q: Quote, mode: string) {
  return (
    e.mode === mode &&
    e.source === "local-simulator" &&
    mode === "L0" &&
    e.final &&
    e.success &&
    e.network === q.network &&
    e.asset === q.asset &&
    e.payer === "demo:payer" &&
    e.recipient === q.recipient &&
    e.amountAtomic === q.outputAtomic
  );
}
export function verifyRefund(e: Evidence, q: Quote) {
  return (
    e.final &&
    e.success &&
    e.mode === "L0" &&
    e.source === "local-simulator" &&
    e.asset === q.asset &&
    e.network === q.network &&
    e.recipient === q.refundTo &&
    e.amountAtomic === q.inputAtomic
  );
}
