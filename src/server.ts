import express from "express";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
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
) {
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
  app.post("/api/demo/session", async (req, res) => {
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
  app.use("/api", (req, res, next) => {
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
  app.get("/api/me", async (_req, res) =>
    res.json({
      user: res.locals.user,
      ...members[res.locals.user as User],
      asset,
      mode: "L0",
      notice: NOTICE,
      levels: { L0: "SIMULATED", L1: "DISABLED", L2: "BLOCKED" },
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
    res.status(404).json({ error: "NOT_FOUND", notice: NOTICE }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      if (error instanceof Fault)
        res.status(error.status).json({ error: error.code, notice: NOTICE });
      else if (error instanceof z.ZodError)
        res.status(400).json({ error: "INVALID_INPUT", notice: NOTICE });
      else res.status(500).json({ error: "INTERNAL_ERROR", notice: NOTICE });
    },
  );
  return app;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  check(
    !process.env.PAYMENT_MODE || process.env.PAYMENT_MODE === "L0",
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
    const server = createApp(service, `http://127.0.0.1:${port}`).listen(
      port,
      "127.0.0.1",
      () =>
        process.stdout.write(
          `L0 ${driver} demo: http://127.0.0.1:${port} — ${NOTICE}\n`,
        ),
    );
    process.once("SIGTERM", () =>
      server.close(() => {
        void close();
      }),
    );
  }
}
