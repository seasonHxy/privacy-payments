import { NearReadOnlyRpc } from "../../src/near-rpc.js";
import type { L1Config, L1Invoice } from "../../src/l1.js";
import { mockRpc, hash, directReceiptFixture } from "./near-fixtures.js";
export const l1FixtureConfig = (): L1Config => ({
  chainId: "testnet",
  genesisHash: hash(1),
  rpcUrl: "https://rpc-fixture.invalid",
  contract: "token-fixture.testnet",
  decimals: 6,
  symbol: "testUSD",
  metadataSource: "https://example.invalid/fixture-only",
  payer: "payer-fixture.testnet",
  recipient: "recipient-fixture.testnet",
  gas: "30000000000000",
});
export function l1FixtureRpc(allowedKeys = new Set<string>()) {
  const base = mockRpc(allowedKeys),
    c = {
      registered: true,
      decimals: 6,
      balance: "1000000000",
      offline: false,
      blockTimestampNs: undefined as string | undefined,
      beforeReceipt: async () => {},
      beforeQuery: async () => {},
    };
  const fetcher: typeof fetch = async (url, init) => {
    if (c.offline) throw Error("fixture offline");
    const req = JSON.parse(init!.body as string);
    if (req.method === "tx_status") await c.beforeReceipt();
    if (req.method === "block") {
      base.control.calls.push(req);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            header: {
              hash: req.params.block_id,
              timestamp_nanosec:
                c.blockTimestampNs ??
                (BigInt(Date.now()) * 1000000n).toString(),
            },
          },
        }),
      );
    }
    if (req.method === "query" && req.params.request_type === "call_function") {
      await c.beforeQuery();
      base.control.calls.push(req);
      let value: unknown;
      if (req.params.method_name === "ft_metadata")
        value = { spec: "ft-1.0.0", symbol: "testUSD", decimals: c.decimals };
      else if (req.params.method_name === "storage_balance_of")
        value = c.registered ? { total: "1", available: "0" } : null;
      else if (req.params.method_name === "ft_balance_of") value = c.balance;
      else throw Error("unexpected function");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            block_hash: hash(2),
            block_height: 123,
            result: [...Buffer.from(JSON.stringify(value))],
          },
        }),
      );
    }
    return base.fetcher(url, init);
  };
  const config = l1FixtureConfig();
  return {
    config,
    control: c,
    rpcControl: base.control,
    fetcher,
    rpc: new NearReadOnlyRpc(
      {
        url: config.rpcUrl,
        chainId: config.chainId,
        genesisHash: config.genesisHash,
      },
      fetcher,
    ),
  };
}
export function receiptFor(i: L1Invoice) {
  const r = directReceiptFixture().receipt;
  r.transaction.actions[0]!.FunctionCall.args = Buffer.from(
    JSON.stringify(i.quote!.request.actions[0].params.args),
  ).toString("base64");
  return r;
}
