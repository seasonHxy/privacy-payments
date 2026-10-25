import { test, expect } from "@playwright/test";

test("L1 unconfigured page blocks payment controls and never falls back to demo", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") requests.push(request.url());
  });
  await page.route("**/api/l1/config", (route) =>
    route.fulfill({
      json: { enabled: false, reason: "L1_CONFIGURATION_REQUIRED", mode: "L1" },
    }),
  );
  await page.goto("/l1.html");
  await expect(
    page.getByRole("heading", { name: "L1 待配置 / 已禁用" }),
  ).toBeVisible();
  await expect(
    page.getByText("testUSD 是无美元价值的测试资产", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建 L1 测试账单" }),
  ).toBeHidden();
  expect(requests).toEqual([]);
});

test("L1 browser fixture: review only, manual reference, UNKNOWN reload and recipient acknowledgement", async ({
  page,
}) => {
  // Browser transport fixture only: no real wallet, RPC, or transaction is involved.
  const id = "c3b267c0-3394-4b8b-bfab-714a0b7b21ce";
  let user = "payer";
  let invoice: Record<string, unknown> | undefined;
  const mutations: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { user, authentication: "NEP413" } }),
  );
  await page.route("**/api/l1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/l1/config")
      return route.fulfill({ json: { enabled: true, network: "testnet" } });
    if (path === "/api/l1/settings")
      return route.fulfill({
        json: {
          enabled: true,
          mode: "L1",
          network: "testnet",
          asset: {
            symbol: "testUSD",
            contract: "token-fixture.testnet",
            decimals: 6,
          },
          payer: "payer-fixture.testnet",
          recipient: "recipient-fixture.testnet",
        },
      });
    if (path === "/api/l1/disclosures") return route.fulfill({ json: [] });
    if (request.method() === "GET")
      return route.fulfill({
        json: path.endsWith("/invoices") ? (invoice ? [invoice] : []) : invoice,
      });
    const body = request.postDataJSON();
    mutations.push({ path, body });
    if (path.endsWith("/invoices")) {
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      invoice = {
        id,
        mode: "L1",
        version: 1,
        revision: 1,
        state: "CREATED",
        amountAtomic: body.amountAtomic,
        purpose: body.purpose,
      };
    } else if (path.endsWith("/approve")) {
      expect(body).toEqual({ version: 1 });
      invoice!.state = "APPROVED";
    } else if (path.endsWith("/quote")) {
      invoice!.state = "QUOTED";
      invoice!.quote = {
        fingerprint: "fixture-quote-fingerprint",
        expiresAt: Date.now() + 60000,
        fees: "NETWORK_FEE_VARIABLE",
        request: {
          signerId: "payer-fixture.testnet",
          receiverId: "token-fixture.testnet",
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: "ft_transfer",
                args: {
                  receiver_id: "recipient-fixture.testnet",
                  amount: "125000000",
                },
                gas: "30000000000000",
                deposit: "1",
              },
            },
          ],
        },
      };
    } else if (path.endsWith("/confirm")) {
      expect(body).toEqual({
        version: 1,
        quoteFingerprint: "fixture-quote-fingerprint",
      });
      invoice!.state = "CONFIRMED";
    } else if (path.endsWith("/prepare-signing"))
      invoice!.state = "AWAITING_SIGNATURE";
    else if (path.endsWith("/execution-reference")) {
      expect(body).toEqual({ reference: "11111111111111111111111111111111" });
      invoice!.reference = body.reference;
      invoice!.state = "UNKNOWN";
    } else if (path.endsWith("/recheck")) {
      invoice!.state = "VERIFIED_SUCCESS";
      invoice!.evidence = {
        source: "browser-fixture-only",
        actualAmountAtomic: "125000000",
      };
    } else if (path.endsWith("/acknowledgement")) {
      expect(user).toBe("recipient");
      invoice!.acknowledgedAt = Date.now();
    } else throw new Error(`Unexpected mutation ${path}`);
    return route.fulfill({ json: invoice });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/l1.html");
  await page.getByLabel("原子单位金额（整数）").fill("125000000");
  await page
    .getByLabel("用途（仅填写假数据）")
    .fill("L1 browser fixture invoice");
  await page.getByRole("button", { name: "创建 L1 测试账单" }).click();
  await page.getByRole("button", { name: "批准当前版本" }).click();
  await page.getByRole("button", { name: "检查前置条件并获取报价" }).click();
  await expect(page.locator("#quote-data")).toContainText(
    "NETWORK_FEE_VARIABLE",
  );
  await page.getByRole("button", { name: "确认当前报价全部条件" }).click();
  await page.getByRole("button", { name: "生成待签请求" }).click();
  await expect(page.locator("#signing")).toContainText(
    '"methodName": "ft_transfer"',
  );
  await expect(page.locator("#signing")).toContainText('"deposit": "1"');
  expect(mutations).toHaveLength(5);
  expect(
    mutations.some((entry) => entry.path.endsWith("execution-reference")),
  ).toBe(false);
  await page.getByLabel("交易哈希").fill("11111111111111111111111111111111");
  await page.getByRole("button", { name: "保存标识，等待核验" }).click();
  await expect(page.locator("#uncertain")).toBeVisible();
  await page.reload();
  await expect(page.locator("#evidence")).toContainText("UNKNOWN");
  await expect(
    page.getByRole("button", { name: "生成待签请求" }),
  ).toBeDisabled();
  expect(mutations).toHaveLength(6);
  await page.getByRole("button", { name: "重新读取 receipt 核验" }).click();
  await expect(page.locator("#evidence")).toContainText("VERIFIED_SUCCESS");
  await expect(
    page.getByRole("button", { name: "收款人确认已核对到账" }),
  ).toBeDisabled();
  user = "recipient";
  await page.reload();
  await page.getByRole("button", { name: "收款人确认已核对到账" }).click();
  await expect(page.locator("#evidence")).toContainText("acknowledgedAt");
  await expect(
    page.getByRole("button", { name: "创建 L1 测试账单" }),
  ).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("L1 expired quote never reaches confirmation endpoint", async ({
  page,
}) => {
  const invoice = {
    id: "expired-fixture",
    mode: "L1",
    version: 1,
    state: "QUOTED",
    purpose: "expired fixture",
    amountAtomic: "1",
    quote: { expiresAt: 1, fingerprint: "expired" },
  };
  const writes: string[] = [];
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { user: "payer", authentication: "NEP413" } }),
  );
  await page.route("**/api/l1/**", (route) => {
    const request = route.request();
    if (request.method() !== "GET") writes.push(request.url());
    const path = new URL(request.url()).pathname;
    if (path.endsWith("disclosures")) return route.fulfill({ json: [] });
    return route.fulfill({
      json: path.endsWith("config")
        ? { enabled: true }
        : path.endsWith("invoices")
          ? [invoice]
          : invoice,
    });
  });
  await page.goto("/l1.html#expired-fixture");
  await expect(page.getByRole("status")).toHaveText("");
  await page.getByRole("button", { name: "确认当前报价全部条件" }).click();
  await expect(page.getByRole("status")).toContainText("QUOTE_EXPIRED");
  expect(writes).toEqual([]);
});
