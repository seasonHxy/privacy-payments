import { test, expect } from "@playwright/test";
test("actual L0 app clears private content on expired session and cross-tab identity switch", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByLabel("用途", { exact: true }).fill("HARDENING_FAKE_PRIVATE");
  await page.getByRole("button", { name: "创建账单", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "不可变版本 v1" }),
  ).toBeVisible();
  const invoiceId = await page.evaluate(() =>
    sessionStorage.getItem("invoice"),
  );
  const base = new URL(page.url()).origin;
  await page.request.post(base + "/api/auth/logout", {
    headers: { Origin: base },
    data: {},
  });
  await page.getByRole("button", { name: "批准当前版本" }).click();
  await expect(page.locator("#content")).not.toContainText(
    "HARDENING_FAKE_PRIVATE",
  );
  await expect(page.locator("#content")).toContainText("已隐藏私密数据");
  await page.goto("/");
  await page.locator(`.open[data-id="${invoiceId}"]`).click();
  await expect(page.locator("#content")).toContainText(
    "HARDENING_FAKE_PRIVATE",
  );
  const other = await context.newPage();
  await other.goto("/");
  await other.getByLabel("模拟身份").selectOption("accountant");
  await expect(other.getByLabel("模拟身份")).toBeEnabled();
  await expect(page.locator("#content")).not.toContainText(
    "HARDENING_FAKE_PRIVATE",
  );
  await expect(page.locator("#content")).toContainText("已隐藏私密数据");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/session-cleared-mobile.png",
    fullPage: true,
  });
});
test("configuration status is public, safe and honest on desktop and narrow screen", async ({
  page,
}) => {
  await page.goto("/status.html");
  await expect(page.getByRole("status")).toContainText("没有暴露账户");
  await expect(page.locator("#levels")).toContainText(
    "L2 保密结算：禁止 / BLOCKED",
  );
  await expect(page.locator("#checks")).toContainText("真实认证：缺失");
  const r = await page.request.get("/api/configuration-status"),
    text = await r.text();
  expect(r.headers()["cache-control"]).toBe("no-store");
  for (const value of [
    "postgresql://",
    "storage.key",
    ".testnet",
    "rpcUrl",
    "genesisHash",
    "/workspace",
  ])
    expect(text).not.toContain(value);
  await page.screenshot({
    path: "test-results/config-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/config-mobile.png",
    fullPage: true,
  });
});
