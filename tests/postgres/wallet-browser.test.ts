import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { NearAuth } from "../../src/near-auth.js";
import { L1Service } from "../../src/l1.js";
import { l1FixtureRpc, receiptFor } from "../helpers/l1-fixtures.js";
import { hash } from "../helpers/near-fixtures.js";
import { createApp } from "../../src/server.js";
import { fakeConfig, signingFixture } from "../helpers/near-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
for (const mode of ["L0", "L1"] as const)
  test(`real browser ${mode} official SDK -> HTTP auth -> PostgreSQL; only wallet and RPC mocked`, async () => {
    const schema = "pwb_" + randomBytes(8).toString("hex");
    const root = new Pool({ connectionString: url });
    await root.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    const key = randomBytes(32),
      repo = new PostgresRepository(pool, key);
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const config = {
      ...fakeConfig(),
      origin,
      walletId: "fixture-injected",
      members: {
        ...fakeConfig().members,
        "recipient-fixture.testnet": "recipient" as const,
      },
    };
    const signer = signingFixture();
    const fixture = l1FixtureRpc(
      new Set(["payer-fixture.testnet|" + signer.publicKey]),
    );
    const rpc = fixture.rpc;
    const auth = new NearAuth(pool, key, config, rpc);
    await repo.migrate();
    const l1 =
      mode === "L1"
        ? new L1Service(pool, key, fixture.config, fixture.rpc)
        : undefined;
    server.on("request", createApp(repo.api(), origin, auth, { l1 }));
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();

      const unexpected: string[] = [];
      page.on("request", (r) => {
        if (!r.url().startsWith(origin + "/")) unexpected.push(r.url());
      });
      await page.exposeFunction(
        "fixtureSign",
        (p: {
          message: string;
          recipient: string;
          nonce: number[];
          network: string;
          signerId: string;
        }) => {
          assert.equal(p.recipient, origin);
          assert.equal(p.network, "testnet");
          assert.equal(p.signerId, "payer-fixture.testnet");
          return {
            accountId: p.signerId,
            publicKey: signer.publicKey,
            signature: signer.sign({
              ...p,
              nonceBase64: Buffer.from(p.nonce).toString("base64"),
            }),
          };
        },
      );
      await page.addInitScript({
        content: `
      window.addEventListener('near-selector-ready', () => window.dispatchEvent(new CustomEvent('near-wallet-injected',{detail:{
        manifest:{id:'fixture-injected',type:'injected',features:{testnet:true,signMessage:true,signInWithoutAddKey:true}},
        signIn:async p=>{if(p.network!=='testnet'||p.addFunctionCallKey!==undefined)throw Error('INVALID_LOGIN_PERMISSION');return [{accountId:'payer-fixture.testnet'}];},
        getAccounts:async()=>[{accountId:'payer-fixture.testnet'}],
        signMessage:async p=>window.fixtureSign({...p,nonce:[...p.nonce]}),
        signOut:async()=>{},signAndSendTransaction:async()=>{throw Error('NO_TRANSACTIONS_ALLOWED');}
      }})));
    `,
      });
      await page.goto(origin);
      await page.getByLabel("已配置的测试网账户").fill("payer-fixture.testnet");
      await page
        .getByRole("button", { name: "连接钱包并签署登录消息" })
        .click();
      await expect(
        page.getByRole("heading", {
          name: mode === "L1" ? "公开测试付款" : "新建模拟账单",
          exact: true,
        }),
      ).toBeVisible();
      assert.equal(
        (await (await page.request.get(origin + "/api/me")).json()).user,
        "payer",
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM auth_challenges WHERE consumed_at IS NOT NULL",
            )
          ).rows[0].n,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM auth_sessions WHERE revoked_at IS NULL",
            )
          ).rows[0].n,
        ),
        1,
      );
      if (mode === "L1") {
        assert(l1);
        await page.getByLabel("原子单位金额（整数）").fill("100");
        await page
          .getByLabel("用途（仅填写假数据）")
          .fill("L1 actual browser fixture only");
        await page.getByRole("button", { name: "创建 L1 测试账单" }).click();
        await page.getByRole("button", { name: "批准当前版本" }).click();
        await page
          .getByRole("button", { name: "检查前置条件并获取报价" })
          .click();
        await page
          .getByRole("button", { name: "确认当前报价全部条件" })
          .click();
        await page.getByRole("button", { name: "生成待签请求" }).click();
        await expect(page.locator("#invoice")).toContainText(
          "AWAITING_SIGNATURE",
        );
        const [invoice] = await l1.list({
          accountId: fixture.config.payer,
          user: "payer",
        });
        assert(invoice);
        fixture.rpcControl.receipt = receiptFor(invoice);
        await page.getByLabel("交易哈希").fill(hash(3));
        await page.getByRole("button", { name: "保存标识，等待核验" }).click();
        await page
          .getByRole("button", { name: "重新读取 receipt 核验" })
          .click();
        await expect(page.locator("#evidence")).toContainText(
          "VERIFIED_SUCCESS",
        );
        assert.equal(
          (await page.request.get(origin + "/api/invoices")).status(),
          403,
        );
        await page.reload();
        await expect(page.locator("#evidence")).toContainText(
          "VERIFIED_SUCCESS",
        );
        await page.screenshot({
          path: "/tmp/privacy-payments-l1.png",
          fullPage: true,
        });
      }
      await page.reload();
      await expect(
        page.getByRole("heading", {
          name: mode === "L1" ? "公开测试付款" : "新建模拟账单",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "退出登录" }).click();
      await expect(
        page.getByRole("heading", { name: "需要钱包登录" }),
      ).toBeVisible();
      assert.equal((await page.request.get(origin + "/api/me")).status(), 401);
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) n FROM auth_sessions WHERE revoked_at IS NULL",
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.deepEqual(unexpected, []);
    } finally {
      await browser.close();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      await repo.close();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  });
