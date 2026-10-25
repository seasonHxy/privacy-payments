import { randomUUID } from "node:crypto";
import { z } from "zod";
import bs58 from "bs58";
import { check, Fault } from "./domain.js";
import { nearPublicKey } from "./nep413.js";
export const nearAccount = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
export const nearHash = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return bs58.decode(value).length === 32;
    } catch {
      return false;
    }
  });
export type RpcPin = { url: string; chainId: "testnet"; genesisHash: string };
export class NearReadOnlyRpc {
  readonly pin: RpcPin;
  constructor(
    pin: RpcPin,
    private fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(pin.url);
    check(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !url.search,
      "INVALID_RPC_ENDPOINT",
      500,
    );
    check(pin.chainId === "testnet", "UNSUPPORTED_NETWORK", 500);
    nearHash.parse(pin.genesisHash);
    this.pin = Object.freeze({ ...pin });
  }
  private async call(
    method: "status" | "query" | "tx_status",
    params: unknown,
  ): Promise<unknown> {
    const id = randomUUID();
    try {
      const response = await this.fetcher(this.pin.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      check(response.ok, "RPC_UNAVAILABLE", 503);
      const reader = response.body?.getReader();
      check(reader, "RPC_EMPTY_BODY", 503);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Fault(503, "RPC_RESPONSE_TOO_LARGE");
        }
        chunks.push(r.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      check(
        body.jsonrpc === "2.0" &&
          body.id === id &&
          !body.error &&
          body.result !== undefined,
        "RPC_REJECTED",
        503,
      );
      return body.result;
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault(503, "RPC_UNAVAILABLE");
    }
  }
  async assertNetwork() {
    const r = z
      .object({
        chain_id: z.string(),
        genesis_hash: z.string(),
        sync_info: z.object({ syncing: z.boolean() }),
      })
      .parse(await this.call("status", null));
    check(
      r.chain_id === this.pin.chainId &&
        r.genesis_hash === this.pin.genesisHash &&
        !r.sync_info.syncing,
      "RPC_NETWORK_MISMATCH",
      503,
    );
  }
  async assertFullAccess(accountId: string, publicKey: string) {
    nearAccount.parse(accountId);
    nearPublicKey(publicKey);
    await this.assertNetwork();
    const r = z
      .object({
        permission: z.unknown(),
        block_hash: nearHash,
        block_height: z.number().int().nonnegative(),
      })
      .parse(
        await this.call("query", {
          request_type: "view_access_key",
          finality: "final",
          account_id: accountId,
          public_key: publicKey,
        }),
      );
    check(r.permission === "FullAccess", "FULL_ACCESS_KEY_REQUIRED", 403);
    return { blockHash: r.block_hash, blockHeight: r.block_height };
  }
  async receipt(hash: string, payer: string) {
    nearHash.parse(hash);
    nearAccount.parse(payer);
    await this.assertNetwork();
    return this.call("tx_status", {
      tx_hash: hash,
      sender_account_id: payer,
      wait_until: "FINAL",
    });
  }
}
/** Strict direct ft_transfer only. A matched log must belong to the transaction's reachable receipt graph.
 * RPC is a trusted data provider, not a light-client proof. No app invoice is settled here.
 */
export function inspectDirectTransfer(
  result: unknown,
  expected: {
    hash: string;
    payer: string;
    contract: string;
    recipient: string;
    amountAtomic: string;
  },
) {
  try {
    const status = z.union([
      z.object({ SuccessValue: z.string() }).strict(),
      z.object({ SuccessReceiptId: nearHash }).strict(),
    ]);
    const outcome = z.object({
      id: nearHash,
      block_hash: nearHash,
      outcome: z.object({
        executor_id: nearAccount,
        receipt_ids: z.array(nearHash),
        logs: z.array(z.string()),
        status,
      }),
    });
    const action = z
      .object({
        FunctionCall: z
          .object({
            method_name: z.literal("ft_transfer"),
            args: z.string(),
            deposit: z.literal("1"),
            gas: z.number().int().nonnegative().safe(),
          })
          .strict(),
      })
      .strict();
    const r = z
      .object({
        final_execution_status: z.literal("FINAL"),
        status: z.object({ SuccessValue: z.string() }).strict(),
        transaction: z.object({
          hash: nearHash,
          signer_id: nearAccount,
          receiver_id: nearAccount,
          actions: z.array(action).length(1),
        }),
        transaction_outcome: outcome,
        receipts_outcome: z.array(outcome).min(1),
      })
      .parse(result);
    check(
      r.transaction.hash === expected.hash &&
        r.transaction.signer_id === expected.payer &&
        r.transaction.receiver_id === expected.contract,
      "TRANSACTION_MISMATCH",
    );
    check(
      r.transaction_outcome.id === expected.hash &&
        r.transaction_outcome.outcome.executor_id === expected.payer,
      "TRANSACTION_OUTCOME_MISMATCH",
    );
    const encodedArgs = r.transaction.actions[0]!.FunctionCall.args;
    check(
      Buffer.from(encodedArgs, "base64").toString("base64") === encodedArgs,
      "NON_CANONICAL_ARGUMENTS",
    );
    const args = z
      .object({
        receiver_id: nearAccount,
        amount: z.string().regex(/^[1-9][0-9]*$/),
        memo: z.string().optional(),
      })
      .strict()
      .parse(
        JSON.parse(
          Buffer.from(
            r.transaction.actions[0]!.FunctionCall.args,
            "base64",
          ).toString(),
        ),
      );
    check(
      args.receiver_id === expected.recipient &&
        args.amount === expected.amountAtomic,
      "TRANSFER_ARGUMENT_MISMATCH",
    );
    const map = new Map(r.receipts_outcome.map((o) => [o.id, o]));
    check(map.size === r.receipts_outcome.length, "DUPLICATE_RECEIPT");
    const visited = new Set<string>();
    const pending = [...r.transaction_outcome.outcome.receipt_ids];
    while (pending.length) {
      const id = pending.pop()!;
      check(!visited.has(id), "AMBIGUOUS_RECEIPT_GRAPH");
      visited.add(id);
      const o = map.get(id);
      check(o, "MISSING_RECEIPT");
      if ("SuccessReceiptId" in o.outcome.status)
        check(
          o.outcome.receipt_ids.includes(o.outcome.status.SuccessReceiptId),
          "DANGLING_RETURN_RECEIPT",
        );
      pending.push(...o.outcome.receipt_ids);
    }
    check(visited.size === map.size, "UNRELATED_RECEIPT");
    const rootIds = r.transaction_outcome.outcome.receipt_ids;
    check(rootIds.length === 1, "AMBIGUOUS_ROOT_RECEIPT");
    const root = map.get(rootIds[0]!)!;
    check(
      "SuccessReceiptId" in r.transaction_outcome.outcome.status &&
        r.transaction_outcome.outcome.status.SuccessReceiptId === root.id,
      "ROOT_RECEIPT_STATUS_MISMATCH",
    );
    check(
      root.outcome.executor_id === expected.contract &&
        "SuccessValue" in root.outcome.status,
      "CONTRACT_RECEIPT_MISMATCH",
    );
    // Only the direct contract action's own logs count; nested transfer logs never substitute.
    const events: unknown[] = [];
    for (const log of root.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const event = z
        .object({
          standard: z.string(),
          version: z.string(),
          event: z.string(),
          data: z.array(z.unknown()),
        })
        .parse(JSON.parse(log.slice(11)));
      if (event.standard === "nep141" && event.event === "ft_transfer") {
        check(event.version === "1.0.0", "EVENT_VERSION_MISMATCH");
        events.push(...event.data);
      }
    }
    check(events.length === 1, "AMBIGUOUS_TRANSFER_EVENT");
    const event = z
      .object({
        old_owner_id: nearAccount,
        new_owner_id: nearAccount,
        amount: z.string().regex(/^[1-9][0-9]*$/),
        memo: z.string().optional(),
      })
      .strict()
      .parse(events[0]);
    check(
      event.old_owner_id === expected.payer &&
        event.new_owner_id === expected.recipient &&
        event.amount === expected.amountAtomic,
      "EVENT_MISMATCH",
    );
    return {
      status: "READ_ONLY_MATCH" as const,
      eventId: root.id,
      trust: "PINNED_RPC_ASSERTION_NOT_LIGHT_CLIENT_PROOF",
    };
  } catch {
    return {
      status: "REVIEW_REQUIRED" as const,
      reason: "FINAL_DIRECT_TRANSFER_EVIDENCE_REQUIRED",
    };
  }
}
export async function fetchAndInspectTransfer(
  rpc: NearReadOnlyRpc,
  expected: Parameters<typeof inspectDirectTransfer>[1],
) {
  try {
    return inspectDirectTransfer(
      await rpc.receipt(expected.hash, expected.payer),
      expected,
    );
  } catch {
    return {
      status: "UNKNOWN" as const,
      reason: "TRUSTED_RPC_EVIDENCE_UNAVAILABLE",
    };
  }
}
