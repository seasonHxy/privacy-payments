import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { check, seal, unseal, fingerprint, type User } from "./domain.js";
import { verifyNep413 } from "./nep413.js";
import { NearReadOnlyRpc, nearAccount, nearHash } from "./near-rpc.js";
export const authConfigSchema = z
  .object({
    origin: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          u.origin === v &&
          (u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
        );
      }),
    rpcUrl: z.string().url(),
    chainId: z.literal("testnet"),
    genesisHash: nearHash,
    walletId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100)
      .optional(),
    members: z
      .record(
        nearAccount,
        z.enum(["payer", "recipient", "accountant", "admin"]),
      )
      .refine(
        (m) =>
          Object.keys(m).length > 0 &&
          new Set(Object.values(m)).size === Object.values(m).length,
      ),
  })
  .strict();
export type AuthConfig = z.infer<typeof authConfigSchema>;
type Challenge = {
  accountId: string;
  nonce: string;
  state: string;
  message: string;
  recipient: string;
  issuedAt: number;
  expiresAt: number;
  configTag: string;
};
type Session = {
  expiresAt?: number;
  accountId: string;
  publicKey: string;
  user: User;
  configTag: string;
};
export const signedLoginSchema = z
  .object({
    challengeId: z.string().uuid(),
    accountId: nearAccount,
    publicKey: z.string().max(60),
    signature: z.string().length(88),
    state: z.string().length(43),
  })
  .strict();
export class NearAuth {
  readonly config: AuthConfig;
  private readonly configTag: string;
  constructor(
    public pool: Pool,
    private key: Buffer,
    config: AuthConfig,
    private rpc: NearReadOnlyRpc,
    private now = () => Date.now(),
  ) {
    check(key.length === 32, "INVALID_AUTH_STORAGE_KEY", 500);
    this.config = structuredClone(authConfigSchema.parse(config));
    check(
      rpc.pin.url === this.config.rpcUrl &&
        rpc.pin.chainId === this.config.chainId &&
        rpc.pin.genesisHash === this.config.genesisHash,
      "AUTH_RPC_PIN_MISMATCH",
      500,
    );
    Object.freeze(this.config.members);
    Object.freeze(this.config);
    this.configTag = fingerprint(this.config);
  }
  private tag(kind: string, value: string) {
    return createHmac("sha256", this.key)
      .update("auth:" + kind + "\0" + value)
      .digest();
  }
  private context(kind: string, id: string) {
    return `privacy-payments:auth:v1:${kind}:${id}`;
  }
  private member(accountId: string) {
    check(
      Object.hasOwn(this.config.members, accountId),
      "ACCOUNT_NOT_AUTHORIZED",
      403,
    );
    const user = this.config.members[accountId];
    check(
      user && ["payer", "recipient", "accountant", "admin"].includes(user),
      "ACCOUNT_NOT_AUTHORIZED",
      403,
    );
    return user;
  }
  private async transaction<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='5s'");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async challenge(accountId: string) {
    nearAccount.parse(accountId);
    this.member(accountId);
    const id = randomUUID(),
      state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64");
    const issuedAt = this.now(),
      expiresAt = issuedAt + 300000;
    const message = JSON.stringify({
      application: "privacy-payments",
      purpose: "login",
      origin: this.config.origin,
      network: this.config.chainId,
      genesisHash: this.config.genesisHash,
      accountId,
      challengeId: id,
      issuedAt,
      expiresAt,
    });
    const payload: Challenge = {
      accountId,
      nonce,
      state,
      message,
      recipient: this.config.origin,
      issuedAt,
      expiresAt,
      configTag: this.configTag,
    };
    await this.pool.query(
      "INSERT INTO auth_challenges(id,nonce_tag,expires_at,payload) VALUES($1,$2,$3,$4)",
      [
        id,
        this.tag("nonce", nonce),
        expiresAt,
        seal(payload, this.key, this.context("challenge", id)),
      ],
    );
    return {
      challengeId: id,
      accountId,
      message,
      nonceBase64: nonce,
      recipient: this.config.origin,
      state,
      expiresAt,
    };
  }
  private async insertSession(c: PoolClient, data: Session, oldToken?: string) {
    const token = randomBytes(32).toString("base64url"),
      tag = this.tag("session", token),
      expiresAt = this.now() + 900000;
    if (oldToken)
      await c.query(
        "UPDATE auth_sessions SET revoked_at=$1 WHERE token_tag=$2 AND revoked_at IS NULL",
        [this.now(), this.tag("session", oldToken)],
      );
    await c.query(
      "INSERT INTO auth_sessions(token_tag,expires_at,payload) VALUES($1,$2,$3)",
      [
        tag,
        expiresAt,
        seal(
          { ...data, expiresAt },
          this.key,
          this.context("session", tag.toString("hex")),
        ),
      ],
    );
    return { token, user: data.user, expiresAt };
  }
  async complete(
    input: unknown,
    browserState: string | undefined,
    oldToken?: string,
  ) {
    const b = signedLoginSchema.parse(input);
    check(
      browserState && b.state === browserState,
      "LOGIN_STATE_MISMATCH",
      403,
    );
    return this.transaction(async (c) => {
      const row = (
        await c.query("SELECT * FROM auth_challenges WHERE id=$1 FOR UPDATE", [
          b.challengeId,
        ])
      ).rows[0];
      check(
        row && !row.consumed_at && Number(row.expires_at) > this.now(),
        "CHALLENGE_EXPIRED_OR_USED",
        403,
      );
      const p = unseal<Challenge>(
        row.payload,
        this.key,
        this.context("challenge", b.challengeId),
      );
      check(
        p.configTag === this.configTag &&
          p.state === browserState &&
          p.accountId === b.accountId &&
          p.recipient === this.config.origin &&
          p.expiresAt === Number(row.expires_at) &&
          p.issuedAt <= this.now(),
        "CHALLENGE_BINDING_MISMATCH",
        403,
      );
      const user = this.member(b.accountId);
      check(
        verifyNep413(
          {
            message: p.message,
            nonce: Buffer.from(p.nonce, "base64"),
            recipient: p.recipient,
          },
          b.publicKey,
          b.signature,
        ),
        "INVALID_LOGIN_SIGNATURE",
        403,
      );
      // A supplied public key is only a lookup candidate. RPC must confirm current FullAccess ownership.
      await this.rpc.assertFullAccess(b.accountId, b.publicKey);
      check(p.expiresAt > this.now(), "CHALLENGE_EXPIRED_OR_USED", 403);
      const used = await c.query(
        "UPDATE auth_challenges SET consumed_at=$1 WHERE id=$2 AND consumed_at IS NULL AND expires_at>$1",
        [this.now(), b.challengeId],
      );
      check(used.rowCount === 1, "CHALLENGE_EXPIRED_OR_USED", 403);
      return this.insertSession(
        c,
        {
          accountId: b.accountId,
          publicKey: b.publicKey,
          user,
          configTag: this.configTag,
        },
        oldToken,
      );
    });
  }
  async resolve(token: string | undefined) {
    check(token && /^[A-Za-z0-9_-]{43}$/.test(token), "UNAUTHENTICATED", 401);
    const tag = this.tag("session", token);
    const row = (
      await this.pool.query("SELECT * FROM auth_sessions WHERE token_tag=$1", [
        tag,
      ])
    ).rows[0];
    check(
      row && !row.revoked_at && Number(row.expires_at) > this.now(),
      "UNAUTHENTICATED",
      401,
    );
    const data = unseal<Session>(
      row.payload,
      this.key,
      this.context("session", tag.toString("hex")),
    );
    check(
      data.expiresAt === Number(row.expires_at),
      "SESSION_METADATA_MISMATCH",
      401,
    );
    check(
      data.configTag === this.configTag &&
        this.member(data.accountId) === data.user,
      "SESSION_MAPPING_CHANGED",
      401,
    );
    await this.rpc.assertFullAccess(data.accountId, data.publicKey);
    // Recheck after network I/O so logout/rotation during RPC cannot resurrect a session.
    const current = (
      await this.pool.query(
        "SELECT revoked_at,expires_at FROM auth_sessions WHERE token_tag=$1",
        [tag],
      )
    ).rows[0];
    check(
      current && !current.revoked_at && Number(current.expires_at) > this.now(),
      "UNAUTHENTICATED",
      401,
    );
    return data;
  }
  async rotate(token: string) {
    const data = await this.resolve(token);
    return this.transaction(async (c) => {
      const r = (
        await c.query(
          "SELECT revoked_at,expires_at FROM auth_sessions WHERE token_tag=$1 FOR UPDATE",
          [this.tag("session", token)],
        )
      ).rows[0];
      check(
        r && !r.revoked_at && Number(r.expires_at) > this.now(),
        "UNAUTHENTICATED",
        401,
      );
      return this.insertSession(c, data, token);
    });
  }
  async logout(token: string | undefined) {
    if (token)
      await this.pool.query(
        "UPDATE auth_sessions SET revoked_at=$1 WHERE token_tag=$2 AND revoked_at IS NULL",
        [this.now(), this.tag("session", token)],
      );
  }
}
