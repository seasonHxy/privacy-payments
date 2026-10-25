import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  loginChallengeBytes,
  verifyLoginProof,
  type LoginChallenge,
} from "../src/login-proof.js";
test("offline login proof binds domain, nonce, account, purpose and time; no session/wallet access", () => {
  // Ephemeral test-only crypto fixture. Never persisted, registered with any chain, or used as a wallet.
  const pair = generateKeyPairSync("ed25519");
  const now = 1800000000000;
  const expected: LoginChallenge = {
    protocol: "privacy-payments-login-v1",
    domain: "https://demo.example",
    purpose: "login",
    accountId: "fixture-only.testnet",
    nonce: Buffer.alloc(32, 1).toString("base64url"),
    issuedAt: now,
    expiresAt: now + 60000,
  };
  const input = {
    expected,
    challenge: expected,
    origin: expected.domain,
    now,
    alreadyConsumed: false,
    signature: sign(null, loginChallengeBytes(expected), pair.privateKey),
    authorizedPublicKeyDer: pair.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer,
  };
  for (const domain of [
    "ftp://localhost",
    "wss://localhost",
    "file://localhost",
    "http://untrusted.example",
  ]) {
    const challenge = { ...expected, domain };
    assert.equal(
      verifyLoginProof({
        ...input,
        expected: challenge,
        challenge,
        origin: domain,
        signature: sign(null, loginChallengeBytes(challenge), pair.privateKey),
      }).valid,
      false,
    );
  }
  assert.deepEqual(verifyLoginProof(input), {
    valid: true,
    reason: "OFFLINE_PROOF_ONLY",
  });
  for (const challenge of [
    { ...expected, domain: "https://evil.example" },
    { ...expected, nonce: Buffer.alloc(32, 2).toString("base64url") },
    { ...expected, accountId: "different.testnet" },
    { ...expected, purpose: "payment" },
    { ...expected, expiresAt: now + 99999 },
    { ...expected, additionalAuthorization: true },
  ])
    assert.equal(verifyLoginProof({ ...input, challenge }).valid, false);
  assert.equal(
    verifyLoginProof({ ...input, alreadyConsumed: true }).valid,
    false,
  );
  assert.equal(
    verifyLoginProof({ ...input, now: expected.expiresAt }).valid,
    false,
  );
  assert.equal(verifyLoginProof({ ...input, now: now - 1 }).valid, false);
  assert.equal(
    verifyLoginProof({ ...input, signature: Buffer.alloc(64) }).valid,
    false,
  );
  assert.equal(
    verifyLoginProof({ ...input, authorizedPublicKeyDer: Buffer.alloc(20) })
      .valid,
    false,
  );
});
