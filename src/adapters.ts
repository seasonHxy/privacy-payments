import { Fault } from "./domain.js";
import { z } from "zod";
/** Real adapters deliberately fail closed. No wallet integration or guessed token address. */
export class DisabledAdapter {
  constructor(public mode: "L1" | "L2") {}
  quote(): never {
    throw new Fault(503, `${this.mode}_CAPABILITIES_UNVERIFIED`);
  }
  prepareSigning(): never {
    return this.quote();
  }
  executionStatus(): never {
    return this.quote();
  }
  verifySettlement(): never {
    return this.quote();
  }
  refund(): never {
    return this.quote();
  }
}
/** Offline validation helper only. Caller must obtain response from a trusted, network-pinned RPC.
 * Does not certify RPC authenticity, contract metadata, or the external payment itself.
 */
export function inspectNearReceipt(
  result: unknown,
  expected: {
    hash: string;
    contract: string;
    payer: string;
    recipient: string;
    amountAtomic: string;
  },
) {
  const status = z.record(z.string(), z.unknown());
  const parsed = z
    .object({
      final_execution_status: z.string(),
      transaction: z.object({
        hash: z.string(),
        signer_id: z.string(),
        receiver_id: z.string(),
      }),
      status,
      receipts_outcome: z.array(
        z.object({
          outcome: z.object({
            executor_id: z.string(),
            status,
            logs: z.array(z.string()),
          }),
        }),
      ),
    })
    .safeParse(result);
  if (!parsed.success)
    return { status: "UNKNOWN", reason: "MALFORMED_OR_MISSING_RECEIPTS" };
  const r = parsed.data;
  if (!r || r.final_execution_status !== "FINAL")
    return { status: "UNKNOWN", reason: "FINAL_RECEIPTS_REQUIRED" };
  if (
    r.transaction?.hash !== expected.hash ||
    r.transaction?.signer_id !== expected.payer ||
    r.transaction?.receiver_id !== expected.contract
  )
    return { status: "REVIEW_REQUIRED", reason: "TRANSACTION_MISMATCH" };
  if (
    Object.hasOwn(r.status, "Failure") ||
    typeof r.status.SuccessValue !== "string"
  )
    return { status: "REVIEW_REQUIRED", reason: "UNSUCCESSFUL_TRANSACTION" };
  const outcomes = r.receipts_outcome;
  if (!Array.isArray(outcomes) || !outcomes.length)
    return { status: "UNKNOWN", reason: "RECEIPTS_MISSING" };
  const transferSchema = z.object({
    old_owner_id: z.string(),
    new_owner_id: z.string(),
    amount: z.string().regex(/^[1-9][0-9]*$/),
  });
  const eventSchema = z.object({
    standard: z.string(),
    version: z.string(),
    event: z.string(),
    data: z.array(transferSchema),
  });
  const transfers: z.infer<typeof transferSchema>[] = [];
  for (const o of outcomes) {
    if (Object.hasOwn(o.outcome.status, "Failure"))
      return { status: "REVIEW_REQUIRED", reason: "FAILED_RECEIPT" };
    if (o.outcome?.executor_id !== expected.contract) continue;
    if (typeof o.outcome.status.SuccessValue !== "string") continue;
    for (const log of o.outcome.logs ?? []) {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
      try {
        const event = eventSchema.parse(JSON.parse(log.slice(11)));
        if (
          event.standard === "nep141" &&
          event.version === "1.0.0" &&
          event.event === "ft_transfer" &&
          Array.isArray(event.data)
        )
          transfers.push(...event.data);
      } catch {
        return { status: "REVIEW_REQUIRED", reason: "MALFORMED_EVENT" };
      }
    }
  }
  if (transfers.length !== 1)
    return { status: "REVIEW_REQUIRED", reason: "AMBIGUOUS_TRANSFER_EVENTS" };
  const e = transfers[0];
  if (
    !e ||
    e.old_owner_id !== expected.payer ||
    e.new_owner_id !== expected.recipient ||
    e.amount !== expected.amountAtomic
  )
    return { status: "REVIEW_REQUIRED", reason: "TRANSFER_MISMATCH" };
  return {
    status: "OFFLINE_MATCH_ONLY",
    reason: "NETWORK_AND_TOKEN_METADATA_NOT_ATTESTED",
  };
}
