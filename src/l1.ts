import { randomUUID, createHmac } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { check, seal, unseal, fingerprint, type User } from "./domain.js";
import {
  NearReadOnlyRpc,
  nearAccount,
  nearHash,
  inspectDirectTransfer,
} from "./near-rpc.js";
export const atomic = z
  .string()
  .regex(/^[1-9][0-9]{0,38}$/)
  .refine((v) => BigInt(v) <= (1n << 128n) - 1n);
export const l1ConfigSchema = z
  .object({
    chainId: z.literal("testnet"),
    genesisHash: nearHash,
    rpcUrl: z.string().url(),
    contract: nearAccount,
    decimals: z.number().int().min(0).max(38),
    symbol: z.literal("testUSD"),
    metadataSource: z.string().url(),
    payer: nearAccount,
    recipient: nearAccount,
    gas: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .refine((v) => BigInt(v) <= 300_000_000_000_000n),
  })
  .strict()
  .refine((v) => v.payer !== v.recipient);
export const l1AttachmentSchema = z
  .object({
    name: z.string().min(1).max(100),
    type: z.literal("text/plain"),
    content: z
      .string()
      .max(65536)
      .refine((v) => Buffer.byteLength(v, "utf8") <= 65536),
  })
  .strict();
const invoiceInput = z
  .object({
    amountAtomic: atomic,
    purpose: z.string().min(1).max(500),
    attachment: l1AttachmentSchema.optional(),
  })
  .strict();
export const disclosureFields = [
  "amountAtomic",
  "purpose",
  "asset",
  "network",
  "payer",
  "recipient",
  "attachment",
  "settlement",
] as const;
export type L1Version = {
  invoiceId: string;
  version: number;
  createdAt: number;
  fingerprint: string;
  payload: z.infer<typeof invoiceInput> & {
    asset: { contract: string; symbol: "testUSD"; decimals: number };
    network: { chainId: "testnet"; genesisHash: string };
    payer: string;
    recipient: string;
  };
};
type L1Grant = {
  id: string;
  invoiceId: string;
  version: number;
  recipient: string;
  fields: (typeof disclosureFields)[number][];
  expiresAt: number;
  revokedAt?: number;
  configTag: string;
  createdAt: number;
};
export type L1Config = z.infer<typeof l1ConfigSchema>;
export type L1Actor = { accountId: string; user: User };
export type L1Invoice = {
  id: string;
  mode: "L1";
  version: number;
  revision: number;
  state: string;
  configTag: string;
  amountAtomic: string;
  purpose: string;
  attachment?: z.infer<typeof l1AttachmentSchema>;
  retiredPayments?: {
    version: number;
    invalidatedAt: number;
    approval?: L1Invoice["approval"];
    quote?: L1Invoice["quote"];
  }[];
  createdAt: number;
  approval?: {
    version: number;
    fingerprint?: string;
    accountId: string;
    at: number;
  };
  quote?: {
    fingerprint: string;
    expiresAt: number;
    network: "testnet";
    contract: string;
    decimals: number;
    targetAtomic: string;
    fees: string;
    refund: string;
    request: {
      signerId: string;
      receiverId: string;
      actions: [
        {
          type: "FunctionCall";
          params: {
            methodName: "ft_transfer";
            args: { receiver_id: string; amount: string; memo: string };
            gas: string;
            deposit: "1";
          };
        },
      ];
    };
  };
  confirmedAt?: number;
  reference?: string;
  evidence?: unknown;
  acknowledgedAt?: number;
  audit?: {
    actor: string;
    state: string;
    at: number;
    event?: string;
    version?: number;
    objectId?: string;
  }[];
};
export class L1Service {
  readonly config: L1Config;
  private readonly configTag: string;
  constructor(
    public pool: Pool,
    private key: Buffer,
    config: L1Config,
    private rpc: NearReadOnlyRpc,
    private now = () => Date.now(),
    public readonly accountant?: string,
  ) {
    if (accountant) nearAccount.parse(accountant);
    this.config = Object.freeze(l1ConfigSchema.parse(config));
    this.configTag = fingerprint(this.config);
    check(key.length === 32, "INVALID_STORAGE_KEY", 500);
    check(
      rpc.pin.url === config.rpcUrl &&
        rpc.pin.chainId === config.chainId &&
        rpc.pin.genesisHash === config.genesisHash,
      "L1_RPC_PIN_MISMATCH",
      500,
    );
  }
  private tag(v: string) {
    return createHmac("sha256", this.key)
      .update("l1:" + v)
      .digest();
  }
  private payer(a: L1Actor) {
    check(
      a.user === "payer" && a.accountId === this.config.payer,
      "L1_PAYER_REQUIRED",
      403,
    );
  }
  private reader(a: L1Actor) {
    check(
      (a.user === "payer" && a.accountId === this.config.payer) ||
        (a.user === "recipient" && a.accountId === this.config.recipient),
      "L1_OBJECT_FORBIDDEN",
      403,
    );
  }
  private decode(row: { id: string; revision: number; payload: Buffer }) {
    const i = unseal<L1Invoice>(row.payload, this.key, "l1:" + row.id);
    check(
      i.id === row.id &&
        i.revision === row.revision &&
        i.configTag === this.configTag &&
        i.mode === "L1",
      "L1_RECORD_BINDING_MISMATCH",
      409,
    );
    return i;
  }
  private snapshot(i: L1Invoice, createdAt = this.now()): L1Version {
    const base = {
      invoiceId: i.id,
      version: i.version,
      createdAt,
      payload: {
        amountAtomic: i.amountAtomic,
        purpose: i.purpose,
        ...(i.attachment ? { attachment: i.attachment } : {}),
        asset: {
          contract: this.config.contract,
          symbol: this.config.symbol,
          decimals: this.config.decimals,
        },
        network: {
          chainId: this.config.chainId,
          genesisHash: this.config.genesisHash,
        },
        payer: this.config.payer,
        recipient: this.config.recipient,
      },
    };
    return { ...base, fingerprint: fingerprint(base) };
  }
  private async version(c: Pool | PoolClient, id: string, version: number) {
    const r = await c.query(
      "SELECT payload FROM l1_invoice_versions WHERE invoice_id=$1 AND version=$2",
      [id, version],
    );
    check(r.rowCount, "VERSION_NOT_FOUND", 404);
    const v = unseal<L1Version>(
      r.rows[0].payload,
      this.key,
      `l1:version:${id}:${version}`,
    );
    const { fingerprint: binding, ...base } = v;
    check(
      v.invoiceId === id &&
        v.version === version &&
        binding === fingerprint(base),
      "VERSION_BINDING_MISMATCH",
      409,
    );
    return v;
  }
  private async insertVersion(c: Pool | PoolClient, v: L1Version) {
    await c.query(
      "INSERT INTO l1_invoice_versions(invoice_id,version,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [
        v.invoiceId,
        v.version,
        seal(v, this.key, `l1:version:${v.invoiceId}:${v.version}`),
      ],
    );
    const saved = await this.version(c, v.invoiceId, v.version);
    check(
      saved.fingerprint === v.fingerprint,
      "VERSION_IMMUTABILITY_CONFLICT",
      409,
    );
    return saved;
  }
  private async ensureVersion(c: Pool | PoolClient, i: L1Invoice) {
    const r = await c.query(
      "SELECT 1 FROM l1_invoice_versions WHERE invoice_id=$1 AND version=$2",
      [i.id, i.version],
    );
    // Only the pre-existing immutable v1 format may be lazily backfilled. Never recreate missing later versions.
    if (!r.rowCount) {
      check(i.version === 1, "VERSION_MISSING", 409);
      await this.insertVersion(c, this.snapshot(i, i.createdAt));
    }
    const v = await this.version(c, i.id, i.version);
    check(
      fingerprint(v.payload) ===
        fingerprint(this.snapshot(i, v.createdAt).payload),
      "INVOICE_VERSION_MISMATCH",
      409,
    );
    return v;
  }
  async list(a: L1Actor) {
    this.reader(a);
    const r = await this.pool.query("SELECT * FROM l1_invoices ORDER BY id");
    return r.rows.map((r) => this.decode(r));
  }
  async get(a: L1Actor, id: string) {
    this.reader(a);
    z.string().uuid().parse(id);
    const r = await this.pool.query("SELECT * FROM l1_invoices WHERE id=$1", [
      id,
    ]);
    check(r.rowCount, "NOT_FOUND", 404);
    const i = this.decode(r.rows[0]);
    await this.ensureVersion(this.pool, i);
    const rows = await this.pool.query(
      "SELECT version FROM l1_invoice_versions WHERE invoice_id=$1 ORDER BY version",
      [id],
    );
    const versions = await Promise.all(
      rows.rows.map((r) => this.version(this.pool, id, r.version)),
    );
    return { ...i, versions };
  }
  async create(a: L1Actor, body: unknown, key: string) {
    this.payer(a);
    z.string().min(8).max(128).parse(key);
    const b = invoiceInput.parse(body);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      // Concurrent identical inserts serialize on the unique HMAC idempotency index.
      const i: L1Invoice = {
        id: randomUUID(),
        mode: "L1",
        version: 1,
        revision: 0,
        state: "CREATED",
        configTag: this.configTag,
        ...b,
        createdAt: this.now(),
      };
      await c.query(
        "INSERT INTO l1_invoices(id,idempotency_tag,revision,payload) VALUES($1,$2,0,$3) ON CONFLICT(idempotency_tag) DO NOTHING",
        [i.id, this.tag("key:" + key), seal(i, this.key, "l1:" + i.id)],
      );
      const r = await c.query(
          "SELECT * FROM l1_invoices WHERE idempotency_tag=$1 FOR UPDATE",
          [this.tag("key:" + key)],
        ),
        old = this.decode(r.rows[0]);
      await this.ensureVersion(c, old);
      const initial = await this.version(c, old.id, 1);
      check(
        fingerprint({
          amountAtomic: initial.payload.amountAtomic,
          purpose: initial.payload.purpose,
          ...(initial.payload.attachment
            ? { attachment: initial.payload.attachment }
            : {}),
        }) === fingerprint(b),
        "IDEMPOTENCY_CONFLICT",
        409,
      );
      await c.query("COMMIT");
      return old;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  private async mutate(
    a: L1Actor,
    id: string,
    fn: (i: L1Invoice, c: PoolClient) => void | Promise<void>,
    recipient = false,
    event = "STATE_UPDATED",
    objectId = id,
  ) {
    if (recipient) this.reader(a);
    else this.payer(a);
    z.string().uuid().parse(id);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      const r = await c.query(
        "SELECT * FROM l1_invoices WHERE id=$1 FOR UPDATE",
        [id],
      );
      check(r.rowCount, "NOT_FOUND", 404);
      const i = this.decode(r.rows[0]);
      const rev = i.revision;
      await this.ensureVersion(c, i);
      await fn(i, c);
      i.audit ??= [];
      i.audit.push({
        actor: a.user,
        state: i.state,
        at: this.now(),
        event,
        version: i.version,
        objectId,
      });
      i.revision++;
      const saved = await c.query(
        "UPDATE l1_invoices SET revision=$2,payload=$3 WHERE id=$1 AND revision=$4",
        [id, i.revision, seal(i, this.key, "l1:" + id), rev],
      );
      check(saved.rowCount === 1, "STATE_CONFLICT", 409);
      await c.query("COMMIT");
      return i;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async edit(a: L1Actor, id: string, expectedVersion: number, body: unknown) {
    z.number().int().positive().parse(expectedVersion);
    const b = invoiceInput.parse(body);
    return this.mutate(
      a,
      id,
      async (i, c) => {
        check(i.version === expectedVersion, "VERSION_CONFLICT", 409);
        check(
          ["CREATED", "APPROVED", "QUOTED", "CONFIRMED"].includes(i.state) &&
            !i.reference,
          "PAYMENT_LOCKED",
          409,
        );
        i.retiredPayments ??= [];
        if (i.approval || i.quote)
          i.retiredPayments.push({
            version: i.version,
            invalidatedAt: this.now(),
            approval: i.approval,
            quote: i.quote,
          });
        i.version++;
        i.amountAtomic = b.amountAtomic;
        i.purpose = b.purpose;
        if (b.attachment) i.attachment = b.attachment;
        else delete i.attachment;
        delete i.approval;
        delete i.quote;
        delete i.confirmedAt;
        delete i.evidence;
        delete i.acknowledgedAt;
        i.state = "CREATED";
        await this.insertVersion(c, this.snapshot(i));
      },
      false,
      "VERSION_CREATED",
    );
  }
  async attachment(a: L1Actor, id: string, version: number) {
    await this.get(a, id);
    z.number().int().positive().parse(version);
    const v = await this.version(this.pool, id, version);
    check(v.payload.attachment, "ATTACHMENT_NOT_FOUND", 404);
    return v.payload.attachment;
  }
  approve(a: L1Actor, id: string, version: number) {
    return this.mutate(a, id, async (i, c) => {
      check(
        version === i.version && ["CREATED", "APPROVED"].includes(i.state),
        "VERSION_OR_STATE_CONFLICT",
        409,
      );
      i.approval = {
        version: i.version,
        fingerprint: (await this.version(c, id, i.version)).fingerprint,
        accountId: a.accountId,
        at: this.now(),
      };
      i.state = "APPROVED";
    });
  }
  private async preflight(i: L1Invoice) {
    const metadata = (
      await this.rpc.viewFunction(this.config.contract, "ft_metadata", {})
    ).value;
    const m = z
      .object({
        spec: z.literal("ft-1.0.0"),
        symbol: z.literal("testUSD"),
        decimals: z.number().int(),
      })
      .parse(metadata);
    check(m.decimals === this.config.decimals, "TOKEN_METADATA_MISMATCH", 409);
    for (const account_id of [this.config.payer, this.config.recipient]) {
      const b = (
        await this.rpc.viewFunction(
          this.config.contract,
          "storage_balance_of",
          { account_id },
        )
      ).value;
      check(b !== null, "STORAGE_REGISTRATION_REQUIRED", 409);
      z.object({
        total: z.string().regex(/^[0-9]+$/),
        available: z.string().regex(/^[0-9]+$/),
      }).parse(b);
    }
    const balance = z
      .string()
      .regex(/^[0-9]+$/)
      .parse(
        (
          await this.rpc.viewFunction(this.config.contract, "ft_balance_of", {
            account_id: this.config.payer,
          })
        ).value,
      );
    check(
      BigInt(balance) >= BigInt(i.amountAtomic),
      "INSUFFICIENT_TEST_TOKEN_BALANCE",
      409,
    );
  }
  quote(a: L1Actor, id: string) {
    return this.mutate(a, id, async (i) => {
      check(
        i.approval?.version === i.version &&
          ["APPROVED", "QUOTED", "CONFIRMED"].includes(i.state),
        "APPROVAL_REQUIRED",
        409,
      );
      await this.preflight(i);
      const q = {
        expiresAt: this.now() + 120000,
        network: "testnet" as const,
        contract: this.config.contract,
        decimals: this.config.decimals,
        targetAtomic: i.amountAtomic,
        fees: "Variable NEAR network fee; gas limit is not a price quote. Attach exactly 1 yoctoNEAR. No service fee.",
        refund:
          "Direct ft_transfer has no app refund service; any return requires a separate verified transfer.",
        request: {
          signerId: this.config.payer,
          receiverId: this.config.contract,
          actions: [
            {
              type: "FunctionCall" as const,
              params: {
                methodName: "ft_transfer" as const,
                args: {
                  receiver_id: this.config.recipient,
                  amount: i.amountAtomic,
                  memo: randomUUID(),
                },
                gas: this.config.gas,
                deposit: "1" as const,
              },
            },
          ] as [
            {
              type: "FunctionCall";
              params: {
                methodName: "ft_transfer";
                args: { receiver_id: string; amount: string; memo: string };
                gas: string;
                deposit: "1";
              };
            },
          ],
        },
      };
      i.quote = {
        ...q,
        fingerprint: fingerprint({
          id: i.id,
          version: i.version,
          config: this.configTag,
          approval: i.approval,
          ...q,
        }),
      };
      i.state = "QUOTED";
    });
  }
  confirm(a: L1Actor, id: string, version: number, quoteFingerprint: string) {
    return this.mutate(a, id, (i) => {
      check(
        i.state === "QUOTED" &&
          version === i.version &&
          i.quote?.fingerprint === quoteFingerprint,
        "QUOTE_BINDING_MISMATCH",
        409,
      );
      check(i.quote.expiresAt > this.now(), "QUOTE_EXPIRED", 409);
      i.confirmedAt = this.now();
      i.state = "CONFIRMED";
    });
  }
  prepare(a: L1Actor, id: string) {
    return this.mutate(a, id, async (i) => {
      check(
        ["CONFIRMED", "AWAITING_SIGNATURE"].includes(i.state) && i.quote,
        "CONFIRMATION_REQUIRED",
        409,
      );
      check(i.quote.expiresAt > this.now(), "QUOTE_EXPIRED", 409);
      await this.preflight(i);
      check(i.quote.expiresAt > this.now(), "QUOTE_EXPIRED", 409);
      i.state = "AWAITING_SIGNATURE";
    });
  }
  submit(a: L1Actor, id: string, reference: string) {
    nearHash.parse(reference);
    return this.mutate(a, id, (i) => {
      if (i.reference) {
        check(i.reference === reference, "EXECUTION_ALREADY_RECORDED", 409);
        return;
      }
      check(i.state === "AWAITING_SIGNATURE", "SIGNING_REQUEST_REQUIRED", 409);
      i.reference = reference;
      i.state = "SUBMITTED";
    });
  }
  async recheck(a: L1Actor, id: string) {
    // Network read precedes row lock; CAS prevents a delayed response overwriting newer state.
    const snapshot = await this.get(a, id);
    check(snapshot.reference, "EXECUTION_REFERENCE_REQUIRED", 409);
    if (snapshot.state === "VERIFIED_SUCCESS") return snapshot;
    check(
      ["SUBMITTED", "UNKNOWN", "REVIEW_REQUIRED"].includes(snapshot.state),
      "STATE_CONFLICT",
      409,
    );
    let raw: unknown;
    try {
      raw = await this.rpc.receipt(snapshot.reference, this.config.payer);
    } catch {
      raw = undefined;
    }
    let blockEvidence: { hash: string; timestamp_nanosec: string } | undefined;
    if (raw !== undefined) {
      const match = inspectDirectTransfer(raw, {
        hash: snapshot.reference,
        payer: this.config.payer,
        contract: this.config.contract,
        recipient: this.config.recipient,
        amountAtomic: snapshot.amountAtomic,
      });
      if (match.status === "READ_ONLY_MATCH") {
        const receipts = (
          raw as { receipts_outcome: { id: string; block_hash: string }[] }
        ).receipts_outcome;
        try {
          blockEvidence = await this.rpc.blockTimestamp(
            receipts.find((r) => r.id === match.eventId)!.block_hash,
          );
        } catch {
          blockEvidence = undefined;
        }
      }
    }
    return this.mutate(
      a,
      id,
      async (i, c) => {
        check(i.revision === snapshot.revision, "STATE_CONFLICT", 409);
        const result =
          raw === undefined ||
          (typeof raw === "object" &&
            raw !== null &&
            "final_execution_status" in raw &&
            raw.final_execution_status !== "FINAL")
            ? { status: "UNKNOWN" as const }
            : inspectDirectTransfer(raw, {
                hash: i.reference!,
                payer: this.config.payer,
                contract: this.config.contract,
                recipient: this.config.recipient,
                amountAtomic: i.amountAtomic,
              });
        i.evidence = { source: "PINNED_TESTNET_RPC", result, raw };
        if (result.status === "READ_ONLY_MATCH") {
          // Reject a transfer with extra memo or differing gas even if its amount matches.
          const tx = (
            raw as {
              transaction: {
                actions: { FunctionCall: { gas: number; args: string } }[];
              };
            }
          ).transaction;
          const action = tx.actions[0]!.FunctionCall;
          if (!(
            String(action.gas) === this.config.gas &&
            fingerprint(
              JSON.parse(Buffer.from(action.args, "base64").toString()),
            ) === fingerprint(i.quote!.request.actions[0].params.args)
          )) {
            i.state = "REVIEW_REQUIRED";
            i.evidence = {
              source: "PINNED_TESTNET_RPC",
              reason: "EXECUTION_REQUEST_MISMATCH",
              raw,
            };
            return;
          }
          if (
            !blockEvidence ||
            !i.confirmedAt ||
            BigInt(blockEvidence.timestamp_nanosec) <
              BigInt(i.confirmedAt) * 1000000n ||
            BigInt(blockEvidence.timestamp_nanosec) >=
              BigInt(i.quote!.expiresAt) * 1000000n
          ) {
            i.state = "REVIEW_REQUIRED";
            i.evidence = {
              source: "PINNED_TESTNET_RPC",
              reason: "EXECUTION_TIME_NOT_WITHIN_CONFIRMED_WINDOW",
              blockEvidence,
              raw,
            };
            return;
          }
          i.evidence = {
            source: "PINNED_TESTNET_RPC",
            result,
            blockEvidence,
            raw,
          };
          const inserted = await c.query(
            "INSERT INTO l1_events(event_tag,invoice_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [
              this.tag(
                "event:" + this.config.genesisHash + ":" + result.eventId,
              ),
              i.id,
            ],
          );
          if (inserted.rowCount !== 1) {
            i.state = "REVIEW_REQUIRED";
            i.evidence = {
              source: "PINNED_TESTNET_RPC",
              reason: "SETTLEMENT_EVENT_REUSED",
              raw,
            };
            return;
          }
          i.state = "VERIFIED_SUCCESS";
        } else i.state = result.status;
      },
      true,
    );
  }
  async acknowledge(a: L1Actor, id: string) {
    check(
      a.user === "recipient" && a.accountId === this.config.recipient,
      "RECIPIENT_REQUIRED",
      403,
    );
    return this.mutate(
      a,
      id,
      (i) => {
        check(i.state === "VERIFIED_SUCCESS", "SETTLEMENT_REQUIRED", 409);
        i.acknowledgedAt ??= this.now();
      },
      true,
    );
  }
  private grantReader(a: L1Actor) {
    check(
      a.user === "accountant" &&
        this.accountant &&
        a.accountId === this.accountant,
      "DISCLOSURE_RECIPIENT_REQUIRED",
      403,
    );
  }
  private decodeGrant(row: any): L1Grant {
    const g = unseal<L1Grant>(row.payload, this.key, "l1:disclosure:" + row.id);
    check(
      g.id === row.id &&
        g.invoiceId === row.invoice_id &&
        g.version === row.version &&
        g.expiresAt === Number(row.expires_at) &&
        (g.revokedAt ?? null) ===
          (row.revoked_at === null ? null : Number(row.revoked_at)) &&
        g.configTag === this.configTag &&
        this.tag("recipient:" + g.recipient).equals(row.recipient_tag),
      "DISCLOSURE_BINDING_MISMATCH",
      409,
    );
    return g;
  }
  async grant(a: L1Actor, body: unknown) {
    this.payer(a);
    const b = z
      .object({
        invoiceId: z.string().uuid(),
        version: z.number().int().positive(),
        recipient: nearAccount,
        fields: z
          .array(z.enum(disclosureFields))
          .min(1)
          .max(disclosureFields.length)
          .refine((f) => new Set(f).size === f.length),
        expiresAt: z.number().int().safe(),
      })
      .strict()
      .parse(body);
    check(
      this.accountant && b.recipient === this.accountant,
      "DISCLOSURE_RECIPIENT_NOT_CONFIGURED",
      403,
    );
    check(
      b.expiresAt > this.now() && b.expiresAt <= this.now() + 30 * 86400000,
      "INVALID_DISCLOSURE_EXPIRY",
      400,
    );
    const g: L1Grant = {
      id: randomUUID(),
      ...b,
      configTag: this.configTag,
      createdAt: this.now(),
    };
    await this.mutate(
      a,
      b.invoiceId,
      async (_i, c) => {
        const v = await this.version(c, b.invoiceId, b.version);
        if (b.fields.includes("attachment"))
          check(v.payload.attachment, "ATTACHMENT_NOT_FOUND", 404);
        await c.query(
          "INSERT INTO l1_disclosures(id,invoice_id,version,recipient_tag,expires_at,payload) VALUES($1,$2,$3,$4,$5,$6)",
          [
            g.id,
            g.invoiceId,
            g.version,
            this.tag("recipient:" + g.recipient),
            g.expiresAt,
            seal(g, this.key, "l1:disclosure:" + g.id),
          ],
        );
      },
      false,
      "DISCLOSURE_GRANTED",
      g.id,
    );
    return this.grantMetadata(g);
  }
  private grantMetadata(g: L1Grant) {
    return {
      id: g.id,
      invoiceId: g.invoiceId,
      version: g.version,
      recipient: g.recipient,
      fields: g.fields,
      expiresAt: g.expiresAt,
      revokedAt: g.revokedAt,
    };
  }
  async grants(a: L1Actor) {
    if (a.user === "payer") this.payer(a);
    else this.grantReader(a);
    const r =
      a.user === "payer"
        ? await this.pool.query("SELECT * FROM l1_disclosures ORDER BY id")
        : await this.pool.query(
            "SELECT * FROM l1_disclosures WHERE recipient_tag=$1 AND revoked_at IS NULL AND expires_at>$2 ORDER BY id",
            [this.tag("recipient:" + a.accountId), this.now()],
          );
    return r.rows
      .map((row) => this.decodeGrant(row))
      .map((g) => this.grantMetadata(g));
  }
  private async authorizedGrant(a: L1Actor, id: string) {
    this.grantReader(a);
    z.string().uuid().parse(id);
    const r = await this.pool.query(
      "SELECT * FROM l1_disclosures WHERE id=$1",
      [id],
    );
    check(r.rowCount, "DISCLOSURE_FORBIDDEN", 403);
    const g = this.decodeGrant(r.rows[0]);
    check(
      g.recipient === a.accountId &&
        g.revokedAt === undefined &&
        g.expiresAt > this.now(),
      "DISCLOSURE_FORBIDDEN",
      403,
    );
    return g;
  }
  async disclosure(a: L1Actor, id: string) {
    const g = await this.authorizedGrant(a, id);
    const v = await this.version(this.pool, g.invoiceId, g.version);
    const fields: Record<string, unknown> = {};
    for (const field of g.fields) {
      if (field === "attachment") {
        const file = v.payload.attachment;
        check(file, "ATTACHMENT_NOT_FOUND", 404);
        fields.attachment = {
          name: file.name,
          type: file.type,
          bytes: Buffer.byteLength(file.content, "utf8"),
        };
      } else if (field === "settlement") {
        const r = await this.pool.query(
          "SELECT * FROM l1_invoices WHERE id=$1",
          [g.invoiceId],
        );
        check(r.rowCount, "NOT_FOUND", 404);
        const i = this.decode(r.rows[0]);
        fields.settlement =
          i.version === g.version
            ? {
                status: i.state,
                verified: i.state === "VERIFIED_SUCCESS",
                recipientAcknowledged: Boolean(i.acknowledgedAt),
                source: i.evidence ? "PINNED_TESTNET_RPC" : "NOT_QUERIED",
                refund: "UNSUPPORTED_DIRECT_TRANSFER",
              }
            : {
                status: "NO_SETTLEMENT_FOR_VERSION",
                verified: false,
                recipientAcknowledged: false,
              };
      } else fields[field] = v.payload[field];
    }
    // Repeat authorization after storage reads: an expiry/revoke during assembly must not return stale access.
    await this.authorizedGrant(a, id);
    return {
      mode: "L1",
      notice:
        "公开测试网 testUSD，无美元价值。只读披露不授予花费权；撤权不收回已下载内容。",
      invoiceId: g.invoiceId,
      version: g.version,
      fields,
    };
  }
  async disclosedAttachment(a: L1Actor, id: string) {
    const g = await this.authorizedGrant(a, id);
    check(g.fields.includes("attachment"), "ATTACHMENT_FORBIDDEN", 403);
    const v = await this.version(this.pool, g.invoiceId, g.version);
    check(v.payload.attachment, "ATTACHMENT_NOT_FOUND", 404);
    await this.authorizedGrant(a, id);
    return v.payload.attachment;
  }
  async revoke(a: L1Actor, id: string) {
    this.payer(a);
    z.string().uuid().parse(id);
    const r = await this.pool.query(
      "SELECT * FROM l1_disclosures WHERE id=$1",
      [id],
    );
    check(r.rowCount, "NOT_FOUND", 404);
    const original = this.decodeGrant(r.rows[0]);
    await this.mutate(
      a,
      original.invoiceId,
      async (_i, c) => {
        const row = (
          await c.query("SELECT * FROM l1_disclosures WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0];
        const g = this.decodeGrant(row);
        g.revokedAt ??= this.now();
        await c.query(
          "UPDATE l1_disclosures SET revoked_at=$2,payload=$3 WHERE id=$1",
          [id, g.revokedAt, seal(g, this.key, "l1:disclosure:" + id)],
        );
      },
      false,
      "DISCLOSURE_REVOKED",
      id,
    );
    return { id, revoked: true };
  }
}
