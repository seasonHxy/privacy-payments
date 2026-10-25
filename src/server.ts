import express from "express";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NearAuth, authConfigSchema } from "./near-auth.js";
import { NearReadOnlyRpc } from "./near-rpc.js";
import { L1Service, l1ConfigSchema, type L1Actor } from "./l1.js";
import {
  Service,
  Store,
  Fault,
  check,
  members,
  NOTICE,
  asset,
  type User,
  type ServiceAPI,
} from "./domain.js";

export function createApp(
  service: ServiceAPI,
  origin = "http://127.0.0.1:3000",
  auth?: NearAuth,
  options: { l1?: L1Service } = {},
) {
  check(!auth || auth.config.origin === origin, "AUTH_ORIGIN_MISMATCH", 500);
  const l1 = options.l1;
  if (l1)
    check(
      auth &&
        auth.config.chainId === l1.config.chainId &&
        auth.config.genesisHash === l1.config.genesisHash &&
        auth.config.rpcUrl === l1.config.rpcUrl &&
        auth.config.members[l1.config.payer] === "payer" &&
        auth.config.members[l1.config.recipient] === "recipient",
      "L1_AUTH_CONFIGURATION_MISMATCH",
      500,
    );
  const app = express();
  app.disable("x-powered-by");
  const sessions = new Map<string, { user: User; expires: number }>();
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  app.use("/api", (req, _res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      check(req.headers.origin === origin, "ORIGIN_FORBIDDEN", 403);
      check(req.is("application/json"), "JSON_REQUIRED", 415);
    }
    next();
  });
  const cookie = (req: express.Request, name: string) =>
    req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1);
  const setAuthCookie = (
    res: express.Response,
    name: string,
    value: string,
    maxAge: number,
  ) =>
    res.append(
      "Set-Cookie",
      `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  app.get("/api/auth/config", (_req, res) =>
    res.json({
      mode: auth ? "NEP413" : "DEMO",
      paymentMode: l1 ? "L1" : "L0",
      wallet: {
        enabled: Boolean(auth?.config.walletId),
        walletId: auth?.config.walletId ?? null,
        network: "testnet",
        transport: "injected",
      },
    }),
  );
  app.get("/api/l1/config", (_req, res) =>
    res.json({
      enabled: Boolean(l1),
      network: "testnet",
      reason: l1 ? null : "L1_CONFIGURATION_REQUIRED",
      notice: "公开测试网 testUSD，无美元价值；待签请求不会自动执行。",
    }),
  );
  app.post("/api/auth/challenge", async (req, res) => {
    check(auth, "REAL_AUTH_DISABLED", 503);
    const b = z.object({ accountId: z.string() }).strict().parse(req.body);
    const challenge = await auth.challenge(b.accountId);
    setAuthCookie(res, "near_challenge", challenge.state, 300);
    res.json(challenge);
  });
  app.post("/api/auth/verify", async (req, res) => {
    check(auth, "REAL_AUTH_DISABLED", 503);
    const session = await auth.complete(
      req.body,
      cookie(req, "near_challenge"),
      cookie(req, "near_session"),
    );
    setAuthCookie(res, "near_session", session.token, 900);
    setAuthCookie(res, "near_challenge", "", 0);
    res.json({
      user: session.user,
      authentication: "NEP413",
      paymentMode: l1 ? "L1" : "L0",
    });
  });
  app.post("/api/auth/rotate", async (req, res) => {
    check(auth, "REAL_AUTH_DISABLED", 503);
    const session = await auth.rotate(cookie(req, "near_session") ?? "");
    setAuthCookie(res, "near_session", session.token, 900);
    res.json({ rotated: true });
  });
  app.post("/api/auth/logout", async (req, res) => {
    if (auth) await auth.logout(cookie(req, "near_session"));
    else {
      const old = cookie(req, "session");
      if (old) sessions.delete(old);
    }
    for (const name of ["session", "near_session", "near_challenge"])
      setAuthCookie(res, name, "", 0);
    res.json({ loggedOut: true });
  });
  app.post("/api/demo/session", async (req, res) => {
    check(!auth, "DEMO_AUTH_DISABLED", 403);
    const { user } = z
      .object({
        user: z.enum([
          "payer",
          "admin",
          "accountant",
          "recipient",
          "outsider",
          "otherRecipient",
        ]),
      })
      .strict()
      .parse(req.body);
    const previous = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("session="))
      ?.slice(8);
    if (previous) sessions.delete(previous);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { user, expires: Date.now() + 3600000 });
    res.setHeader(
      "Set-Cookie",
      `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
    );
    res.json({ user, mode: "L0", notice: NOTICE });
  });
  app.use("/api", async (req, res, next) => {
    if (auth) {
      const identity = await auth.resolve(cookie(req, "near_session"));
      res.locals.user = identity.user;
      res.locals.identity = identity;
      next();
      return;
    }
    const token = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("session="))
      ?.slice(8);
    const session = token ? sessions.get(token) : undefined;
    check(session && session.expires > Date.now(), "UNAUTHENTICATED", 401);
    res.locals.user = session.user;
    next();
  });
  // L1 objects never pass through the L0 simulator, even with a valid NEAR session.
  app.use("/api/l1", (_req, res, next) => {
    check(l1 && auth && res.locals.identity, "L1_DISABLED", 503);
    next();
  });
  const actor = (res: express.Response) => res.locals.identity as L1Actor;
  app.get("/api/l1/settings", (_req, res) => {
    const a = actor(res);
    check(
      l1 &&
        ((a.user === "payer" && a.accountId === l1.config.payer) ||
          (a.user === "recipient" && a.accountId === l1.config.recipient)),
      "L1_OBJECT_FORBIDDEN",
      403,
    );
    res.json({
      enabled: true,
      network: "testnet",
      asset: {
        symbol: "testUSD",
        contract: l1.config.contract,
        decimals: l1.config.decimals,
      },
      payer: l1.config.payer,
      recipient: l1.config.recipient,
    });
  });
  app.get("/api/l1/invoices", async (_req, res) =>
    res.json(await l1!.list(actor(res))),
  );
  app.post("/api/l1/invoices", async (req, res) =>
    res
      .status(201)
      .json(
        await l1!.create(
          actor(res),
          req.body,
          req.get("Idempotency-Key") ?? "",
        ),
      ),
  );
  app.get("/api/l1/invoices/:id", async (req, res) =>
    res.json(await l1!.get(actor(res), req.params.id)),
  );
  app.post("/api/l1/invoices/:id/approve", async (req, res) => {
    const b = z.object({ version: z.number().int() }).strict().parse(req.body);
    res.json(await l1!.approve(actor(res), req.params.id, b.version));
  });
  app.post("/api/l1/invoices/:id/quote", async (req, res) =>
    res.json(await l1!.quote(actor(res), req.params.id)),
  );
  app.post("/api/l1/invoices/:id/confirm", async (req, res) => {
    const b = z
      .object({ version: z.number().int(), quoteFingerprint: z.string() })
      .strict()
      .parse(req.body);
    res.json(
      await l1!.confirm(
        actor(res),
        req.params.id,
        b.version,
        b.quoteFingerprint,
      ),
    );
  });
  app.post("/api/l1/invoices/:id/prepare-signing", async (req, res) =>
    res.json(await l1!.prepare(actor(res), req.params.id)),
  );
  app.post("/api/l1/invoices/:id/execution-reference", async (req, res) => {
    const b = z.object({ reference: z.string() }).strict().parse(req.body);
    res
      .status(202)
      .json(await l1!.submit(actor(res), req.params.id, b.reference));
  });
  app.post("/api/l1/invoices/:id/recheck", async (req, res) =>
    res.json(await l1!.recheck(actor(res), req.params.id)),
  );
  app.post("/api/l1/invoices/:id/acknowledgement", async (req, res) =>
    res.json(await l1!.acknowledge(actor(res), req.params.id)),
  );
  app.use("/api", (req, _res, next) => {
    check(!l1 || req.path === "/me", "L0_DISABLED_IN_L1_MODE", 403);
    next();
  });
  app.get("/api/me", async (_req, res) =>
    res.json({
      user: res.locals.user,
      ...members[res.locals.user as User],
      asset: l1
        ? {
            symbol: "testUSD",
            decimals: l1.config.decimals,
            contract: l1.config.contract,
          }
        : asset,
      mode: l1 ? "L1" : "L0",
      notice: l1 ? "公开测试网 testUSD，无美元价值；不会自动付款。" : NOTICE,
      levels: {
        L0: l1 ? "ISOLATED_DISABLED" : "SIMULATED",
        L1: l1 ? "CONFIGURED_NOT_CHAIN_ACCEPTED" : "DISABLED",
        L2: "BLOCKED",
      },
      authentication: auth ? "NEP413" : "DEMO",
    }),
  );
  app.get("/api/invoices", async (_req, res) =>
    res.json(await service.list(res.locals.user)),
  );
  app.post("/api/invoices", async (req, res) =>
    res.status(201).json(await service.create(res.locals.user, req.body)),
  );
  app.get("/api/invoices/:id", async (req, res) =>
    res.json(await service.get(res.locals.user, req.params.id)),
  );
  app.patch("/api/invoices/:id", async (req, res) => {
    const { expectedVersion, payload } = z
      .object({ expectedVersion: z.number().int(), payload: z.unknown() })
      .strict()
      .parse(req.body);
    res.json(
      await service.edit(
        res.locals.user,
        req.params.id,
        expectedVersion,
        payload,
      ),
    );
  });
  app.post("/api/invoices/:id/approvals", async (req, res) => {
    const b = z.object({ version: z.number().int() }).strict().parse(req.body);
    res.json(await service.approve(res.locals.user, req.params.id, b.version));
  });
  app.post("/api/invoices/:id/payment-attempts", async (req, res) => {
    const b = z
      .object({
        version: z.number().int(),
        mode: z.enum(["L0", "L1", "L2"]).default("L0"),
      })
      .strict()
      .parse(req.body);
    res.json(
      await service.start(
        res.locals.user,
        req.params.id,
        b.version,
        req.get("Idempotency-Key") ?? "",
        b.mode,
      ),
    );
  });
  app.post("/api/invoices/:id/acknowledgement", async (req, res) =>
    res.json(await service.acknowledge(res.locals.user, req.params.id)),
  );
  app.get("/api/invoices/:id/attachment", async (req, res) => {
    const i = await service.get(res.locals.user, req.params.id);
    const version = z.coerce.number().int().positive().parse(req.query.version);
    const a = i.versions.find((v) => v.version === version)?.payload.attachment;
    check(a, "NOT_FOUND", 404);
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": "attachment; filename=invoice-note.txt",
    });
    res.send(a.content);
  });
  app.get("/api/payment-attempts/:id", async (req, res) =>
    res.json(await service.status(res.locals.user, req.params.id)),
  );
  app.post("/api/payment-attempts/:id/quote", async (req, res) =>
    res.json(await service.quote(res.locals.user, req.params.id)),
  );
  app.post("/api/payment-attempts/:id/confirm", async (req, res) => {
    const b = z
      .object({ version: z.number().int(), quoteFingerprint: z.string() })
      .strict()
      .parse(req.body);
    res.json(
      await service.confirm(
        res.locals.user,
        req.params.id,
        b.version,
        b.quoteFingerprint,
      ),
    );
  });
  app.post("/api/payment-attempts/:id/prepare-signing", async (req, res) =>
    res.json(await service.prepare(res.locals.user, req.params.id)),
  );
  app.post("/api/payment-attempts/:id/reject", async (req, res) =>
    res.json(await service.reject(res.locals.user, req.params.id)),
  );
  app.post(
    "/api/payment-attempts/:id/execution-reference",
    async (req, res) => {
      const b = z.object({ reference: z.string() }).strict().parse(req.body);
      const a = await service.submit(
        res.locals.user,
        req.params.id,
        b.reference,
      );
      res.status(202).json(a);
      setImmediate(async () => {
        try {
          await service.verify(a.id, a.revision);
        } catch {
          // Keep persisted SUBMITTED for explicit recovery. Never turn verifier errors into success.
          process.stderr.write(
            "Verification deferred: local evidence check failed.\n",
          );
        }
      });
    },
  );
  app.post("/api/payment-attempts/:id/recheck", async (req, res) => {
    await service.status(res.locals.user, req.params.id);
    res.json(await service.verify(req.params.id));
  });
  app.get("/api/disclosures", async (_req, res) =>
    res.json(await service.grants(res.locals.user)),
  );
  app.post("/api/disclosures", async (req, res) =>
    res.status(201).json(await service.grant(res.locals.user, req.body)),
  );
  app.get("/api/disclosures/:id", async (req, res) =>
    res.json(await service.disclosure(res.locals.user, req.params.id)),
  );
  app.get("/api/disclosures/:id/export", async (req, res) => {
    const d = await service.disclosure(res.locals.user, req.params.id);
    res
      .set(
        "Content-Disposition",
        "attachment; filename=simulated-disclosure.json",
      )
      .json(d);
  });
  app.delete("/api/disclosures/:id", async (req, res) =>
    res.json(await service.revoke(res.locals.user, req.params.id)),
  );
  app.use(express.static(resolve("public")));
  app.use(async (_req, res) =>
    res
      .status(404)
      .json({
        error: "NOT_FOUND",
        notice: l1 ? "公开测试网待签模式，无自动付款。" : NOTICE,
      }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      const notice = l1
        ? "公开测试网 testUSD，无美元价值；付款不会自动执行。"
        : NOTICE;
      if (error instanceof Fault)
        res.status(error.status).json({ error: error.code, notice });
      else if (error instanceof z.ZodError)
        res.status(400).json({ error: "INVALID_INPUT", notice });
      else res.status(500).json({ error: "INTERNAL_ERROR", notice });
    },
  );
  return app;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  check(
    !process.env.PAYMENT_MODE ||
      process.env.PAYMENT_MODE === "L0" ||
      (process.env.PAYMENT_MODE === "L1" &&
        process.env.AUTH_MODE === "near" &&
        process.env.STORAGE_DRIVER === "postgres" &&
        process.env.L1_CONFIG),
    "REAL_MODES_DISABLED",
    500,
  );
  const directory = resolve(process.env.DATA_DIR ?? "data");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = resolve(directory, "storage.key");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const driver = process.env.STORAGE_DRIVER ?? "sqlite";
  check(["sqlite", "postgres"].includes(driver), "INVALID_STORAGE_DRIVER", 500);
  const authMode = process.env.AUTH_MODE ?? "demo";
  check(["demo", "near"].includes(authMode), "INVALID_AUTH_MODE", 500);
  let auth: NearAuth | undefined;
  let l1: L1Service | undefined;
  let origin =
    process.env.APP_ORIGIN ??
    `http://127.0.0.1:${Number(process.env.PORT ?? 3000)}`;
  if (authMode === "near")
    check(
      driver === "postgres" && process.env.NEAR_AUTH_CONFIG,
      "AUTH_CONFIGURATION_REQUIRED",
      500,
    );
  let service: ServiceAPI;
  let close: () => void | Promise<void>;
  if (driver === "postgres") {
    check(process.env.DATABASE_URL, "DATABASE_URL_REQUIRED", 500);
    const url = new URL(process.env.DATABASE_URL);
    check(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "LOCAL_DATABASE_REQUIRED",
      500,
    );
    const { Pool } = await import("pg");
    const { PostgresRepository } = await import("./postgres.js");
    const repo = new PostgresRepository(
      new Pool({ connectionString: process.env.DATABASE_URL }),
      readFileSync(keyPath),
    );
    await repo.migrate();
    service = repo.api();
    if (authMode === "near") {
      const config = authConfigSchema.parse(
        JSON.parse(
          readFileSync(resolve(process.env.NEAR_AUTH_CONFIG!), "utf8"),
        ),
      );
      check(
        process.env.APP_ORIGIN === config.origin,
        "AUTH_ORIGIN_CONFIGURATION_REQUIRED",
        500,
      );
      origin = config.origin;
      auth = new NearAuth(
        repo.pool,
        readFileSync(keyPath),
        config,
        new NearReadOnlyRpc({
          url: config.rpcUrl,
          chainId: config.chainId,
          genesisHash: config.genesisHash,
        }),
      );
      if (process.env.PAYMENT_MODE === "L1") {
        const paymentConfig = l1ConfigSchema.parse(
          JSON.parse(readFileSync(resolve(process.env.L1_CONFIG!), "utf8")),
        );
        l1 = new L1Service(
          repo.pool,
          readFileSync(keyPath),
          paymentConfig,
          new NearReadOnlyRpc({
            url: paymentConfig.rpcUrl,
            chainId: paymentConfig.chainId,
            genesisHash: paymentConfig.genesisHash,
          }),
        );
      }
    }
    close = () => repo.close();
  } else {
    const store = new Store(
      resolve(directory, "app.sqlite"),
      readFileSync(keyPath),
    );
    service = new Service(store);
    close = () => store.close();
  }
  if (process.env.MIGRATE_ONLY === "1") {
    await close();
    process.stdout.write("Local L0 schema ready.\n");
  } else {
    await service.recover();
    const port = Number(process.env.PORT ?? 3000);
    const server = createApp(service, origin, auth, { l1 }).listen(
      port,
      "127.0.0.1",
      () =>
        process.stdout.write(
          `${l1 ? "L1 request-only" : "L0 demo"} ${driver}: http://127.0.0.1:${port} — ${l1 ? "公开测试网待签模式，无自动付款。" : NOTICE}\n`,
        ),
    );
    process.once("SIGTERM", () =>
      server.close(() => {
        void close();
      }),
    );
  }
}
