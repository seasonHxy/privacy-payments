import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeNep413, verifyNep413 } from "../src/nep413.js";
import {
  NearReadOnlyRpc,
  inspectDirectTransfer,
  fetchAndInspectTransfer,
} from "../src/near-rpc.js";
import {
  signingFixture,
  hash,
  mockRpc,
  directReceiptFixture,
} from "./helpers/near-fixtures.js";
test("NEP-413 official hi example serializes exact Borsh bytes, callback option and prefix", () => {
  const p = {
    message: "hi",
    nonce: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
    recipient: "myapp.com",
    callbackUrl: "myapp.com/callback",
  };
  const expected =
    "9d010080" +
    "020000006869" +
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "090000006d796170702e636f6d" +
    "01" +
    "120000006d796170702e636f6d2f63616c6c6261636b";
  assert.equal(encodeNep413(p).toString("hex"), expected);
  const { callbackUrl: _callback, ...without } = p;
  void _callback;
  assert.equal(encodeNep413(without).at(-1), 0);
  const fixture = signingFixture();
  const login = {
    message: "login only",
    nonceBase64: Buffer.alloc(32, 7).toString("base64"),
    recipient: "https://fixture.example",
  };
  const signature = fixture.sign(login),
    payload = {
      message: login.message,
      nonce: Buffer.from(login.nonceBase64, "base64"),
      recipient: login.recipient,
    };
  assert.equal(verifyNep413(payload, fixture.publicKey, signature), true);
  for (const change of [
    { message: "payment" },
    { recipient: "https://evil.example" },
    { nonce: Buffer.alloc(32, 8) },
    { callbackUrl: "https://evil.example" },
  ])
    assert.equal(
      verifyNep413({ ...payload, ...change }, fixture.publicKey, signature),
      false,
    );
  assert.equal(verifyNep413(payload, fixture.publicKey, "bad"), false);
});
test("read-only RPC pins chain/genesis and checks current account FullAccess, never writes", async () => {
  const f = signingFixture(),
    keys = new Set(["payer-fixture.testnet|" + f.publicKey]),
    { fetcher, control } = mockRpc(keys);
  const rpc = new NearReadOnlyRpc(
    {
      url: "https://rpc-fixture.invalid",
      chainId: "testnet",
      genesisHash: hash(1),
    },
    fetcher,
  );
  await rpc.assertFullAccess("payer-fixture.testnet", f.publicKey);
  assert.equal(control.calls.at(-1)!.params.finality, "final");
  control.permission = { FunctionCall: { receiver_id: "x.testnet" } };
  await assert.rejects(
    rpc.assertFullAccess("payer-fixture.testnet", f.publicKey),
  );
  control.permission = "FullAccess";
  keys.clear();
  await assert.rejects(
    rpc.assertFullAccess("payer-fixture.testnet", f.publicKey),
  );
  keys.add("payer-fixture.testnet|" + f.publicKey);
  control.chain = "mainnet";
  await assert.rejects(
    rpc.assertFullAccess("payer-fixture.testnet", f.publicKey),
  );
  control.chain = "testnet";
  control.genesis = hash(9);
  await assert.rejects(
    rpc.assertFullAccess("payer-fixture.testnet", f.publicKey),
  );
  assert.ok(control.calls.every((c) => ["status", "query"].includes(c.method)));
});
test("receipt fixture requires FINAL, direct contract receipt and connected graph; nested or unrelated logs fail", async () => {
  const { receipt, expected } = directReceiptFixture();
  assert.equal(
    inspectDirectTransfer(receipt, expected).status,
    "READ_ONLY_MATCH",
  );
  const mutations: ((r: any) => void)[] = [
    (r) => (r.final_execution_status = "EXECUTED_OPTIMISTIC"),
    (r) => (r.transaction.actions[0].Transfer = { deposit: "1" }),
    (r) => (r.transaction.actions[0].FunctionCall.args += "!!!"),
    (r) =>
      (r.receipts_outcome[1].outcome.status = { SuccessReceiptId: hash(9) }),
    (r) => (r.receipts_outcome[0].outcome.executor_id = "fake.testnet"),
    (r) => (r.receipts_outcome[0].outcome.status = { Failure: {} }),
    (r) => (r.receipts_outcome[0].outcome.logs = []),
    (r) =>
      (r.receipts_outcome[1].outcome.logs =
        r.receipts_outcome[0].outcome.logs.splice(0)),
    (r) => (r.transaction_outcome.outcome.receipt_ids = [hash(9)]),
    (r) => r.receipts_outcome.push({ ...r.receipts_outcome[0], id: hash(8) }),
    (r) =>
      (r.transaction.actions[0].FunctionCall.method_name = "ft_transfer_call"),
    (r) => (r.transaction.hash = hash(9)),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.equal(
      inspectDirectTransfer(changed, expected).status,
      "REVIEW_REQUIRED",
    );
  }
  assert.equal(
    inspectDirectTransfer({ hash: expected.hash }, expected).status,
    "REVIEW_REQUIRED",
  );
  const { control, fetcher } = mockRpc(new Set());
  control.receipt = receipt;
  const rpc = new NearReadOnlyRpc(
    {
      url: "https://rpc-fixture.invalid",
      chainId: "testnet",
      genesisHash: hash(1),
    },
    fetcher,
  );
  assert.equal(
    (await fetchAndInspectTransfer(rpc, expected)).status,
    "READ_ONLY_MATCH",
  );
  assert.deepEqual(control.calls.at(-1), {
    jsonrpc: "2.0",
    id: control.calls.at(-1)!.id,
    method: "tx_status",
    params: {
      tx_hash: expected.hash,
      sender_account_id: expected.payer,
      wait_until: "FINAL",
    },
  } as any);
  control.chain = "mainnet";
  assert.equal(
    (await fetchAndInspectTransfer(rpc, expected)).status,
    "UNKNOWN",
  );
});

test("RPC redirects, mismatched IDs and malformed responses fail without fallback", async () => {
  const pin = {
    url: "https://rpc-fixture.invalid",
    chainId: "testnet" as const,
    genesisHash: hash(1),
  };
  const bad: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "unrelated",
        result: {
          chain_id: "testnet",
          genesis_hash: hash(1),
          sync_info: { syncing: false },
        },
      }),
    );
  await assert.rejects(new NearReadOnlyRpc(pin, bad).assertNetwork());
  let policy: RequestRedirect | undefined;
  const redirect: typeof fetch = async (_url, init) => {
    policy = init!.redirect;
    throw Error("redirect forbidden");
  };
  await assert.rejects(new NearReadOnlyRpc(pin, redirect).assertNetwork());
  assert.equal(policy, "error");
});
