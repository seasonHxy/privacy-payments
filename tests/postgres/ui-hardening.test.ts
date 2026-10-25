import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { Pool } from "pg";
import { PostgresRepository } from "../../src/postgres.js";
import { NearAuth } from "../../src/near-auth.js";
import { L1Service } from "../../src/l1.js";
import { createApp } from "../../src/server.js";
import { l1FixtureRpc, receiptFor } from "../helpers/l1-fixtures.js";
import { signingFixture, hash } from "../helpers/near-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
if (!url) throw Error("TEST_DATABASE_URL required");
test("actual L1 browser history, double clicks, slow RPC logout fence, wrong network and UNKNOWN recovery; no route mocks", async () => {
  const root = new Pool({ connectionString: url }),
    schema = "pui_" + randomBytes(8).toString("hex");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    }),
    key = randomBytes(32),
    repo = new PostgresRepository(pool, key);
  await repo.migrate();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const signer = signingFixture(),
    receiver = signingFixture();
  const f = l1FixtureRpc(
    new Set([
      "payer-fixture.testnet|" + signer.publicKey,
      "recipient-fixture.testnet|" + receiver.publicKey,
    ]),
  );
  const auth = new NearAuth(
    pool,
    key,
    {
      origin,
      rpcUrl: f.config.rpcUrl,
      chainId: "testnet",
      genesisHash: f.config.genesisHash,
      members: { [f.config.payer]: "payer", [f.config.recipient]: "recipient" },
    },
    f.rpc,
  );
  const l1 = new L1Service(pool, key, f.config, f.rpc);
  server.on("request", createApp(repo.api(), origin, auth, { l1 }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  let release = () => {};
  try {
    const context = await browser.newContext(),
      page = await context.newPage();
    const login = async (account = f.config.payer, fixture = signer) => {
      const c = await auth.challenge(account);
      const s = await auth.complete(
        {
          challengeId: c.challengeId,
          state: c.state,
          accountId: account,
          publicKey: fixture.publicKey,
          signature: fixture.sign(c),
        },
        c.state,
      );
      await context.addCookies([
        {
          name: "near_session",
          value: s.token,
          url: origin,
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
    };
    await login();
    await page.goto(origin + "/l1.html");
    await page.getByLabel("原子单位金额（整数）").fill("100");
    await page.getByLabel("用途（仅填写假数据）").fill("SAFE_FAKE_ONE");
    await page
      .getByLabel("纯文本附件（可选，最大64 KiB）")
      .fill("<script>window.downloadExecuted=true</script>");
    await page.locator("#create-form").evaluate((form: any) => {
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(page.locator("#invoice")).toContainText("SAFE_FAKE_ONE");
    assert.equal(
      (await l1.list({ user: "payer", accountId: f.config.payer })).length,
      1,
    );
    await page.getByLabel("用途（仅填写假数据）").fill("SAFE_FAKE_TWO");
    await page.getByRole("button", { name: "创建 L1 测试账单" }).click();
    await expect(page.locator("#invoice")).toContainText("SAFE_FAKE_TWO");
    await page.goBack();
    await expect(page.locator("#invoice")).toContainText("SAFE_FAKE_ONE");
    await page.goForward();
    await expect(page.locator("#invoice")).toContainText("SAFE_FAKE_TWO");
    await page
      .getByLabel("修改用途")
      .fill('<img src=x onerror="window.injected=true">');
    await page.getByRole("button", { name: "保存新版本，失效旧审批" }).click();
    await expect(page.locator("#invoice")).toContainText("onerror");
    assert.equal(
      await page.evaluate(() => (window as any).injected),
      undefined,
    );
    assert.equal(await page.locator("#invoice img").count(), 0);
    const id = new URL(page.url()).hash.slice(1);
    const download = await page.request.get(
      origin + `/api/l1/invoices/${id}/attachment?version=1`,
    );
    assert.match(download.headers()["content-type"]!, /^text\/plain/);
    assert.match(download.headers()["content-disposition"]!, /^attachment/);
    assert.equal(download.headers()["x-content-type-options"], "nosniff");
    assert.match(await download.text(), /<script>/);
    await page.getByRole("button", { name: "批准当前版本" }).click();
    await expect(page.locator("#invoice")).toContainText("APPROVED");
    let entered = () => {};
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    f.control.beforeQuery = async () => {
      entered();
      await gate;
    };
    const quoteResponse = page.waitForResponse((r) =>
      r.url().endsWith("/quote"),
    );
    await page.getByRole("button", { name: "检查前置条件并获取报价" }).click();
    await started;
    await expect(
      page.getByRole("button", { name: "检查前置条件并获取报价" }),
    ).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("处理中");
    await page.request.post(origin + "/api/auth/logout", {
      headers: { Origin: origin },
      data: {},
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#workspace")).toBeHidden();
    release();
    f.control.beforeQuery = async () => {};
    await quoteResponse;
    await expect(page.locator("body")).not.toContainText("onerror");
    assert.equal(
      (await l1.get({ user: "payer", accountId: f.config.payer }, id)).state,
      "QUOTED",
    );
    await login();
    await page.reload();
    await expect(page.locator("#invoice")).toContainText("QUOTED");
    f.rpcControl.chain = "mainnet";
    await page.getByRole("button", { name: "刷新已保存状态" }).click();
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("body")).not.toContainText("onerror");
    f.rpcControl.chain = "testnet";
    await page.reload();
    await page.getByRole("button", { name: "确认当前报价全部条件" }).click();
    await page.getByRole("button", { name: "生成待签请求" }).click();
    await expect(page.locator("#invoice")).toContainText("AWAITING_SIGNATURE");
    await page.getByLabel("交易哈希").fill(hash(3));
    await page.getByRole("button", { name: "保存标识，等待核验" }).click();
    f.rpcControl.receipt = { final_execution_status: "INCLUDED" };
    await page.getByRole("button", { name: "重新读取 receipt 核验" }).click();
    await expect(page.locator("#evidence")).toContainText("UNKNOWN");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "生成待签请求" }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "/tmp/pp-l1-unknown-mobile.png",
      fullPage: true,
    });
    const i = await l1.get({ user: "payer", accountId: f.config.payer }, id);
    f.rpcControl.receipt = receiptFor(i);
    await login(f.config.recipient, receiver);
    await page.reload();
    await page.getByRole("button", { name: "重新读取 receipt 核验" }).click();
    await expect(page.locator("#evidence")).toContainText("VERIFIED_SUCCESS");
    await page.getByRole("button", { name: "收款人确认已核对到账" }).click();
    await expect(page.locator("#evidence")).toContainText("acknowledgedAt");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: "/tmp/pp-l1-recipient-desktop.png",
      fullPage: true,
    });
  } finally {
    release();
    await browser.close();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await repo.close();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
