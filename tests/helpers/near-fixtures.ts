import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { nep413Digest } from "../../src/nep413.js";
import type { AuthConfig } from "../../src/near-auth.js";
export const hash = (n: number) => bs58.encode(Buffer.alloc(32, n));
export function signingFixture() {
  const key = generateKeyPairSync("ed25519");
  const der = key.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKey = "ed25519:" + bs58.encode(der.subarray(-32));
  return {
    publicKey,
    sign: (p: { message: string; nonceBase64: string; recipient: string }) =>
      sign(
        null,
        nep413Digest({
          message: p.message,
          nonce: Buffer.from(p.nonceBase64, "base64"),
          recipient: p.recipient,
        }),
        key.privateKey,
      ).toString("base64"),
  };
}
export function fakeConfig(): AuthConfig {
  return {
    origin: "http://127.0.0.1:3000",
    rpcUrl: "https://rpc-fixture.invalid",
    chainId: "testnet",
    genesisHash: hash(1),
    members: {
      "payer-fixture.testnet": "payer",
      "viewer-fixture.testnet": "accountant",
    },
  };
}
export function mockRpc(allowedKeys: Set<string>) {
  const control = {
    chain: "testnet",
    genesis: hash(1),
    permission: "FullAccess" as unknown,
    receipt: {} as unknown,
    calls: [] as { id: string; jsonrpc: string; method: string; params: any }[],
  };
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    control.calls.push(request);
    let result: any;
    if (request.method === "status")
      result = {
        chain_id: control.chain,
        genesis_hash: control.genesis,
        sync_info: { syncing: false },
      };
    else if (request.method === "query") {
      if (
        !allowedKeys.has(
          request.params.account_id + "|" + request.params.public_key,
        )
      )
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: "key not present" },
          }),
        );
      result = {
        permission: control.permission,
        nonce: 1,
        block_hash: hash(2),
        block_height: 123,
      };
    } else if (request.method === "tx_status") result = control.receipt;
    else throw Error("write RPC forbidden in fixture");
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    );
  };
  return { control, fetcher };
}
export function directReceiptFixture() {
  const expected = {
    hash: hash(3),
    payer: "payer-fixture.testnet",
    contract: "token-fixture.testnet",
    recipient: "recipient-fixture.testnet",
    amountAtomic: "100",
  };
  const root = hash(4),
    refund = hash(5);
  const receipt = {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: {
      hash: expected.hash,
      signer_id: expected.payer,
      receiver_id: expected.contract,
      actions: [
        {
          FunctionCall: {
            method_name: "ft_transfer",
            args: Buffer.from(
              JSON.stringify({
                receiver_id: expected.recipient,
                amount: expected.amountAtomic,
              }),
            ).toString("base64"),
            deposit: "1",
            gas: 30000000000000,
          },
        },
      ],
    },
    transaction_outcome: {
      id: expected.hash,
      block_hash: hash(2),
      outcome: {
        executor_id: expected.payer,
        receipt_ids: [root],
        logs: [],
        status: { SuccessReceiptId: root },
      },
    },
    receipts_outcome: [
      {
        id: root,
        block_hash: hash(2),
        outcome: {
          executor_id: expected.contract,
          receipt_ids: [refund],
          logs: [
            "EVENT_JSON:" +
              JSON.stringify({
                standard: "nep141",
                version: "1.0.0",
                event: "ft_transfer",
                data: [
                  {
                    old_owner_id: expected.payer,
                    new_owner_id: expected.recipient,
                    amount: expected.amountAtomic,
                  },
                ],
              }),
          ],
          status: { SuccessValue: "" },
        },
      },
      {
        id: refund,
        block_hash: hash(2),
        outcome: {
          executor_id: expected.payer,
          receipt_ids: [],
          logs: [],
          status: { SuccessValue: "" },
        },
      },
    ],
  };
  return { expected, receipt };
}
