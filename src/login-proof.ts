import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const challengeSchema = z
  .object({
    protocol: z.literal("privacy-payments-login-v1"),
    domain: z.string().url(),
    purpose: z.literal("login"),
    accountId: z.string().min(1).max(128),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();
export type LoginChallenge = z.infer<typeof challengeSchema>;
export function loginChallengeBytes(challenge: LoginChallenge): Buffer {
  const c = challengeSchema.parse(challenge);
  return Buffer.from(
    JSON.stringify({
      protocol: c.protocol,
      domain: c.domain,
      purpose: c.purpose,
      accountId: c.accountId,
      nonce: c.nonce,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    }),
    "utf8",
  );
}
/** Offline verifier only. No session creation, NEP-413 envelope or chain account-key resolver.
 * expected must come from the server's nonce store, never from untrusted request fields.
 * Caller must atomically consume that nonce before issuing a session.
 */
export function verifyLoginProof(input: {
  challenge: unknown;
  expected: LoginChallenge;
  origin: string;
  now: number;
  alreadyConsumed: boolean;
  signature: Buffer;
  authorizedPublicKeyDer: Buffer;
}): { valid: boolean; reason: string } {
  try {
    const parsed = challengeSchema.safeParse(input.challenge);
    if (!parsed.success) return { valid: false, reason: "INVALID_CHALLENGE" };
    const c = parsed.data,
      origin = new URL(input.origin);
    if (
      origin.origin !== input.origin ||
      c.domain !== input.origin ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
      )
    )
      return { valid: false, reason: "DOMAIN_MISMATCH" };
    if (input.alreadyConsumed)
      return { valid: false, reason: "NONCE_ALREADY_CONSUMED" };
    if (
      c.expiresAt <= input.now ||
      c.issuedAt > input.now ||
      c.expiresAt - c.issuedAt > 300000 ||
      c.expiresAt <= c.issuedAt
    )
      return { valid: false, reason: "CHALLENGE_EXPIRED_OR_INVALID" };
    const bytes = loginChallengeBytes(c);
    if (!bytes.equals(loginChallengeBytes(input.expected)))
      return { valid: false, reason: "CHALLENGE_MISMATCH" };
    const key = createPublicKey({
      key: input.authorizedPublicKeyDer,
      format: "der",
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      input.signature.length !== 64 ||
      !verify(null, bytes, key, input.signature)
    )
      return { valid: false, reason: "INVALID_SIGNATURE" };
    return { valid: true, reason: "OFFLINE_PROOF_ONLY" };
  } catch {
    return { valid: false, reason: "INVALID_PROOF" };
  }
}
