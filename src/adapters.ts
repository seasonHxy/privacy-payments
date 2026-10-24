import { Fault } from "./domain.js";
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
  const r = result as any;
  if (!r || r.final_execution_status !== "FINAL")
    return { status: "UNKNOWN", reason: "FINAL_RECEIPTS_REQUIRED" };
  if (
    r.transaction?.hash !== expected.hash ||
    r.transaction?.signer_id !== expected.payer ||
    r.transaction?.receiver_id !== expected.contract
  )
    return { status: "REVIEW_REQUIRED", reason: "TRANSACTION_MISMATCH" };
  if (!r.status || !Object.hasOwn(r.status, "SuccessValue"))
    return { status: "REVIEW_REQUIRED", reason: "UNSUCCESSFUL_TRANSACTION" };
  const outcomes = r.receipts_outcome;
  if (!Array.isArray(outcomes) || !outcomes.length)
    return { status: "UNKNOWN", reason: "RECEIPTS_MISSING" };
  const transfers: any[] = [];
  for (const o of outcomes) {
    if (o.outcome?.status?.Failure)
      return { status: "REVIEW_REQUIRED", reason: "FAILED_RECEIPT" };
    if (o.outcome?.executor_id !== expected.contract) continue;
    if (!o.outcome.status || !Object.hasOwn(o.outcome.status, "SuccessValue"))
      continue;
    for (const log of o.outcome.logs ?? []) {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
      try {
        const event = JSON.parse(log.slice(11));
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
