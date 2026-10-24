import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Service,
  Store,
  Fault,
  seal,
  unseal,
  matchesSettlement,
  verifyRefund,
  type Payload,
} from "../src/domain.js";
import { inspectNearReceipt, DisabledAdapter } from "../src/adapters.js";
const payload: Payload = {
  amountAtomic: "125000000",
  asset: "mock:USD",
  network: "mock-local",
  recipient: "recipient",
  address: "demo:recipient",
  purpose: "PRIVATE_MARKER_92",
};
function fixture() {
  let time = 1800000000000;
  const store = new Store(":memory:", randomBytes(32));
  const service = new Service(store, () => time);
  return { s: service, store, advance: (n: number) => (time += n) };
}
function ready(s: Service) {
  const i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  const a = s.start("payer", i.invoiceId, 1, "test-key-0001");
  const q = s.quote("payer", a.id);
  s.confirm("payer", a.id, 1, q.quote!.fingerprint);
  return { i, a, q: q.quote! };
}
function fails(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof Fault && e.code === code);
}
test("01 L0 full flow, recipient acknowledgement, exact scoped export", () => {
  const { s, store } = fixture();
  const { i, a } = ready(s);
  assert.equal(s.prepare("payer", a.id).walletRequest, null);
  assert.equal(s.submit("payer", a.id, "sim:success").state, "SUBMITTED");
  assert.equal(s.verify(a.id).state, "VERIFIED_SUCCESS");
  s.acknowledge("recipient", i.invoiceId);
  const g = s.grant("payer", {
    invoiceId: i.invoiceId,
    version: 1,
    recipient: "accountant",
    fields: ["amountAtomic", "evidence"],
    expiresAt: s.now() + 1000,
  });
  const d = s.disclosure("accountant", g.id);
  assert.equal(d.amountAtomic, payload.amountAtomic);
  assert.equal(d.purpose, undefined);
  assert.equal(d.address, undefined);
  assert.equal((d.evidence as any).receivedAcknowledged, true);
  assert.equal((d.evidence as any).recipient, undefined);
  fails(
    () => s.start("payer", i.invoiceId, 1, "different-key"),
    "ALREADY_SETTLED",
  );
  store.close();
});
test("02 workspace/object/role isolation and admin has no spending power", () => {
  const { s } = fixture();
  const i = s.create("payer", payload);
  for (const u of ["accountant", "admin", "otherRecipient"] as const)
    fails(() => s.get(u, i.invoiceId), "OBJECT_FORBIDDEN");
  fails(() => s.get("outsider", i.invoiceId), "NOT_FOUND");
  for (const u of ["accountant", "admin", "recipient"] as const)
    fails(() => s.approve(u, i.invoiceId, 1), "PAYER_REQUIRED");
  assert.equal(s.get("recipient", i.invoiceId).current, 1);
});
test("03 amount/address/attachment edits invalidate approval and quote; immutable history", () => {
  for (const change of [
    { amountAtomic: "1" },
    { address: "demo:changed" },
    {
      attachment: { name: "note.txt", type: "text/plain", content: "changed" },
    },
  ]) {
    const { s } = fixture();
    const i = s.create("payer", payload);
    s.approve("payer", i.invoiceId, 1);
    const a = s.start("payer", i.invoiceId, 1, "test-key-0001");
    const q = s.quote("payer", a.id);
    s.edit("payer", i.invoiceId, 1, { ...payload, ...change });
    fails(
      () => s.confirm("payer", a.id, 1, q.quote!.fingerprint),
      "INVALID_STATE",
    );
    fails(
      () => s.start("payer", i.invoiceId, 2, "test-key-0002"),
      "APPROVAL_REQUIRED",
    );
    assert.equal(
      s.get("payer", i.invoiceId).versions[0]!.payload.amountAtomic,
      payload.amountAtomic,
    );
    fails(() => s.edit("payer", i.invoiceId, 1, payload), "VERSION_CONFLICT");
  }
});
test("04 only one active attempt across independent persistent connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "pp-lock-"));
  const key = randomBytes(32),
    path = join(directory, "db");
  const a = new Store(path, key),
    b = new Store(path, key);
  const s = new Service(a),
    other = new Service(b);
  const i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  s.start("payer", i.invoiceId, 1, "one-key-0001");
  fails(
    () => other.start("payer", i.invoiceId, 1, "two-key-0002"),
    "ACTIVE_ATTEMPT_EXISTS",
  );
  a.close();
  b.close();
  rmSync(directory, { recursive: true });
});
test("05 idempotency same parameters reuse, differing invoice/version/mode conflicts", () => {
  const { s } = fixture();
  const { i, a } = ready(s);
  assert.equal(s.start("payer", i.invoiceId, 1, "test-key-0001").id, a.id);
  fails(
    () => s.start("payer", i.invoiceId, 2, "test-key-0001"),
    "IDEMPOTENCY_CONFLICT",
  );
  fails(
    () => s.start("payer", i.invoiceId, 1, "test-key-0001", "L1"),
    "IDEMPOTENCY_CONFLICT",
  );
});
test("06 quote expiry, altered fingerprint, re-quote invalidation, signing lock", () => {
  const { s, advance } = fixture();
  const i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  const a = s.start("payer", i.invoiceId, 1, "test-key-0001");
  const q = s.quote("payer", a.id);
  fails(
    () => s.confirm("payer", a.id, 1, "modified-fee-or-asset"),
    "QUOTE_BINDING_MISMATCH",
  );
  advance(120001);
  fails(
    () => s.confirm("payer", a.id, 1, q.quote!.fingerprint),
    "QUOTE_EXPIRED",
  );
  const q2 = s.quote("payer", a.id);
  fails(
    () => s.confirm("payer", a.id, 1, q.quote!.fingerprint),
    "QUOTE_BINDING_MISMATCH",
  );
  s.confirm("payer", a.id, 1, q2.quote!.fingerprint);
  fails(() => s.edit("payer", i.invoiceId, 1, payload), "PAYMENT_LOCKED");
  advance(120001);
  fails(() => s.prepare("payer", a.id), "QUOTE_EXPIRED");
});
test("07 refusal, timeout, persisted submitted restart, duplicate references", () => {
  const { s } = fixture();
  const { a, i } = ready(s);
  s.submit("payer", a.id, "sim:timeout");
  assert.equal(s.verify(a.id).state, "UNKNOWN");
  assert.equal(s.verify(a.id).state, "UNKNOWN");
  fails(
    () => s.start("payer", i.invoiceId, 1, "new-key-0002"),
    "ACTIVE_ATTEMPT_EXISTS",
  );
  fails(() => s.submit("payer", a.id, "sim:success"), "REFERENCE_CONFLICT");
  const f = fixture();
  const r = ready(f.s);
  assert.equal(f.s.reject("payer", r.a.id).state, "USER_REJECTED");
  assert.equal(
    f.s.start("payer", r.i.invoiceId, 1, "new-key-0002").state,
    "CREATED",
  );
  const dir = mkdtempSync(join(tmpdir(), "pp-restart-"));
  const key = randomBytes(32),
    path = join(dir, "db");
  const st = new Store(path, key),
    first = new Service(st);
  const run = ready(first);
  first.submit("payer", run.a.id, "sim:success");
  st.close();
  const reopened = new Store(path, key),
    second = new Service(reopened);
  second.recover();
  assert.equal(second.status("payer", run.a.id).state, "VERIFIED_SUCCESS");
  const rev = second.status("payer", run.a.id).revision;
  second.recover();
  assert.equal(second.status("payer", run.a.id).revision, rev);
  reopened.close();
  rmSync(dir, { recursive: true });
});
test("08 wrong chain/token/address/amount/finality/failure/mode do not settle", () => {
  const { s } = fixture(),
    { a, q } = ready(s);
  s.submit("payer", a.id, "sim:success");
  const e = s.verify(a.id).evidence!;
  for (const changed of [
    { network: "near-testnet" },
    { asset: "fake:USD" },
    { recipient: "demo:other" },
    { amountAtomic: "1" },
    { payer: "other" },
    { final: false },
    { success: false },
    { mode: "L1" },
  ])
    assert.equal(matchesSettlement({ ...e, ...changed }, q, "L0"), false);
  assert.equal(matchesSettlement(e, q, "L1"), false);
  const f = fixture(),
    r = ready(f.s);
  f.s.submit("payer", r.a.id, "sim:underpaid");
  assert.equal(f.s.verify(r.a.id).state, "REVIEW_REQUIRED");
  assert.equal(f.s.get("payer", r.i.invoiceId).settled, false);
});
test("09 missing/partial/wrong refunds cannot be full refund; no client refund setter", () => {
  const { s } = fixture(),
    { a, q } = ready(s);
  s.submit("payer", a.id, "sim:refund-partial");
  const e = s.verify(a.id).evidence!;
  assert.equal(s.status("payer", a.id).state, "REVIEW_REQUIRED");
  assert.equal(verifyRefund(e, q), false);
  const valid = { ...e, recipient: q.refundTo, amountAtomic: q.inputAtomic };
  assert.equal(verifyRefund(valid, q), true);
  for (const c of [
    { amountAtomic: "1" },
    { asset: "fake" },
    { recipient: "wrong" },
    { final: false },
  ])
    assert.equal(verifyRefund({ ...valid, ...c }, q), false);
});
test("10 authenticated encryption rejects damage, storage contains no plaintext marker", () => {
  const key = randomBytes(32),
    encrypted = seal(payload, key);
  encrypted[30] = encrypted[30]! ^ 1;
  assert.throws(() => unseal(encrypted, key));
  const dir = mkdtempSync(join(tmpdir(), "pp-crypto-")),
    path = join(dir, "db");
  const st = new Store(path, key);
  new Service(st).create("payer", payload);
  st.close();
  assert.equal(
    readFileSync(path).includes(Buffer.from(payload.purpose)),
    false,
  );
  rmSync(dir, { recursive: true });
});
test("11 version/field/recipient isolation, expiry and revocation", () => {
  const { s, advance } = fixture();
  const i = s.create("payer", payload);
  const g = s.grant("payer", {
    invoiceId: i.invoiceId,
    version: 1,
    recipient: "accountant",
    fields: ["purpose"],
    expiresAt: s.now() + 100,
  });
  s.edit("payer", i.invoiceId, 1, { ...payload, purpose: "new" });
  assert.equal(s.disclosure("accountant", g.id).purpose, payload.purpose);
  fails(() => s.disclosure("recipient", g.id), "DISCLOSURE_FORBIDDEN");
  assert.equal(s.disclosure("accountant", g.id).amountAtomic, undefined);
  advance(101);
  fails(
    () => s.disclosure("accountant", g.id),
    "DISCLOSURE_EXPIRED_OR_REVOKED",
  );
  const g2 = s.grant("payer", {
    invoiceId: i.invoiceId,
    version: 2,
    recipient: "accountant",
    fields: ["purpose"],
    expiresAt: s.now() + 100,
  });
  s.revoke("payer", g2.id);
  fails(
    () => s.disclosure("accountant", g2.id),
    "DISCLOSURE_EXPIRED_OR_REVOKED",
  );
});
test("12 real modes disabled with no fallback; no testUSD masquerading as USDC", () => {
  const { s } = fixture(),
    i = s.create("payer", payload);
  s.approve("payer", i.invoiceId, 1);
  for (const m of ["L1", "L2"] as const) {
    fails(
      () => s.start("payer", i.invoiceId, 1, "real-key-0001", m),
      "CHANNEL_DISABLED",
    );
    const a = new DisabledAdapter(m);
    for (const method of [
      "quote",
      "prepareSigning",
      "executionStatus",
      "verifySettlement",
      "refund",
    ] as const)
      fails(() => a[method](), `${m}_CAPABILITIES_UNVERIFIED`);
  }
  assert.throws(() => s.create("payer", { ...payload, asset: "testUSD" }));
});
test("amount validation rejects floats, negative, zero, leading zeros, >78 digits, and Number", () => {
  const { s } = fixture();
  for (const value of ["0", "-1", "1.01", "01", "1e6", "9".repeat(79), 125])
    assert.throws(() => s.create("payer", { ...payload, amountAtomic: value }));
  const i = s.create("payer", {
    ...payload,
    amountAtomic: "900719925474099312345",
  });
  assert.equal(
    s.get("payer", i.invoiceId).versions[0]!.payload.amountAtomic,
    "900719925474099312345",
  );
  assert.throws(() =>
    s.create("payer", {
      ...payload,
      attachment: {
        name: "x.html",
        type: "text/html",
        content: "<script>bad</script>",
      },
    }),
  );
});
test("offline NEAR final event matching is never labelled verified real settlement", () => {
  const expected = {
    hash: "fixture",
    contract: "fixture.testnet",
    payer: "payer.testnet",
    recipient: "recipient.testnet",
    amountAtomic: "100",
  };
  const result = {
    final_execution_status: "FINAL",
    transaction: {
      hash: expected.hash,
      signer_id: expected.payer,
      receiver_id: expected.contract,
    },
    status: { SuccessValue: "" },
    receipts_outcome: [
      {
        outcome: {
          executor_id: expected.contract,
          status: { SuccessValue: "" },
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
                    amount: "100",
                  },
                ],
              }),
          ],
        },
      },
    ],
  };
  assert.equal(
    inspectNearReceipt(result, expected).status,
    "OFFLINE_MATCH_ONLY",
  );
  assert.equal(
    inspectNearReceipt({ transaction: { hash: "fixture" } }, expected).status,
    "UNKNOWN",
  );
  assert.equal(
    inspectNearReceipt(
      { ...result, final_execution_status: "EXECUTED_OPTIMISTIC" },
      expected,
    ).status,
    "UNKNOWN",
  );
  assert.equal(
    inspectNearReceipt(result, { ...expected, contract: "fake.testnet" })
      .status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    inspectNearReceipt(result, { ...expected, amountAtomic: "101" }).status,
    "REVIEW_REQUIRED",
  );
  const failed = structuredClone(result);
  (failed.receipts_outcome[0]!.outcome as any).status = { Failure: {} };
  assert.equal(inspectNearReceipt(failed, expected).status, "REVIEW_REQUIRED");
});

test("review regression: one atomic underpayment stays REVIEW_REQUIRED, zero received", () => {
  const { s } = fixture();
  const i = s.create("payer", { ...payload, amountAtomic: "1" });
  s.approve("payer", i.invoiceId, 1);
  const a = s.start("payer", i.invoiceId, 1, "boundary-key");
  const q = s.quote("payer", a.id);
  s.confirm("payer", a.id, 1, q.quote!.fingerprint);
  s.submit("payer", a.id, "sim:underpaid");
  const verified = s.verify(a.id);
  assert.equal(verified.state, "REVIEW_REQUIRED");
  assert.equal(verified.evidence!.amountAtomic, "0");
  assert.equal(s.get("payer", i.invoiceId).settled, false);
});
test("review regression: corrupted unknown reference never becomes successful; evidence collision rolls back", () => {
  const { s } = fixture(),
    { a, i } = ready(s);
  s.submit("payer", a.id, "sim:success");
  s.store.tx((state) => {
    state.attempts.find((x) => x.id === a.id)!.reference = "unrecognized";
  });
  assert.equal(s.verify(a.id).state, "UNKNOWN");
  assert.equal(s.get("payer", i.invoiceId).settled, false);
  s.store.tx((state) => {
    state.attempts.find((x) => x.id === a.id)!.reference = "sim:success";
  });
  s.verify(a.id);
  const second = s.create("payer", payload);
  s.approve("payer", second.invoiceId, 1);
  const b = s.start("payer", second.invoiceId, 1, "second-attempt-key");
  const q = s.quote("payer", b.id);
  s.confirm("payer", b.id, 1, q.quote!.fingerprint);
  s.submit("payer", b.id, "sim:success");
  s.store.tx((state) => {
    state.attempts.find((x) => x.id === a.id)!.evidence!.eventId =
      `mock:${b.id}`;
  });
  fails(() => s.verify(b.id), "EVIDENCE_ALREADY_ASSIGNED");
  assert.equal(s.status("payer", b.id).state, "SUBMITTED");
  assert.equal(s.status("payer", b.id).evidence, undefined);
  assert.equal(s.get("payer", second.invoiceId).settled, false);
});
test("review regression: malformed receipt shapes return conservative result, never throw", () => {
  const expected = {
    hash: "fixture",
    contract: "fixture.testnet",
    payer: "payer.testnet",
    recipient: "recipient.testnet",
    amountAtomic: "1",
  };
  const base = {
    final_execution_status: "FINAL",
    transaction: {
      hash: expected.hash,
      signer_id: expected.payer,
      receiver_id: expected.contract,
    },
    status: { SuccessValue: "" },
    receipts_outcome: [
      {
        outcome: {
          executor_id: expected.contract,
          status: { SuccessValue: "" },
          logs: [] as unknown,
        },
      },
    ],
  };
  for (const value of [
    null,
    1,
    "x",
    [],
    {},
    { ...base, receipts_outcome: [null] },
    { ...base, receipts_outcome: [1] },
    { ...base, receipts_outcome: "x" },
    {
      ...base,
      receipts_outcome: [
        {
          outcome: {
            executor_id: expected.contract,
            status: { SuccessValue: "" },
            logs: 3,
          },
        },
      ],
    },
  ])
    assert.notEqual(
      inspectNearReceipt(value, expected).status,
      "OFFLINE_MATCH_ONLY",
    );
  for (const data of [
    [null],
    [1],
    ["x"],
    [
      {
        old_owner_id: expected.payer,
        new_owner_id: expected.recipient,
        amount: 1,
      },
    ],
  ]) {
    const b = structuredClone(base);
    b.receipts_outcome[0]!.outcome.logs = [
      "EVENT_JSON:" +
        JSON.stringify({
          standard: "nep141",
          version: "1.0.0",
          event: "ft_transfer",
          data,
        }),
    ];
    assert.equal(inspectNearReceipt(b, expected).status, "REVIEW_REQUIRED");
  }
});
