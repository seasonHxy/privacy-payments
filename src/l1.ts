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
export type L1Config = z.infer<typeof l1ConfigSchema>;
export type L1Actor = { accountId: string; user: User };
export type L1Invoice = {
  id: string;
  mode: "L1";
  version: 1;
  revision: number;
  state: string;
  configTag: string;
  amountAtomic: string;
  purpose: string;
  createdAt: number;
  approval?: { version: 1; accountId: string; at: number };
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
  audit?: { actor: string; state: string; at: number }[];
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
  ) {
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
    return this.decode(r.rows[0]);
  }
  async create(a: L1Actor, body: unknown, key: string) {
    this.payer(a);
    z.string().min(8).max(128).parse(key);
    const b = z
      .object({ amountAtomic: atomic, purpose: z.string().min(1).max(500) })
      .strict()
      .parse(body);
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
      check(
        old.amountAtomic === b.amountAtomic && old.purpose === b.purpose,
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
      await fn(i, c);
      i.audit ??= [];
      i.audit.push({ actor: a.user, state: i.state, at: this.now() });
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
  approve(a: L1Actor, id: string, version: number) {
    return this.mutate(a, id, (i) => {
      check(
        version === 1 && ["CREATED", "APPROVED"].includes(i.state),
        "VERSION_OR_STATE_CONFLICT",
        409,
      );
      i.approval = { version: 1, accountId: a.accountId, at: this.now() };
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
        i.approval && ["APPROVED", "QUOTED", "CONFIRMED"].includes(i.state),
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
          version === 1 &&
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
}
