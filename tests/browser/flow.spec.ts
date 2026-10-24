import { test, expect } from "@playwright/test";
test("four screens, reload recovery, recipient check, scoped export, revoke, mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByLabel("用途", { exact: true })
    .fill("E2E fake design " + Date.now());
  await page.getByRole("button", { name: "创建账单", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "不可变版本 v1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "批准当前版本" }).click();
  await expect(page.getByText("有效 · payer", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "进入付款确认" }).click();
  await page.getByRole("button", { name: "创建支付尝试" }).click();
  await page.getByRole("button", { name: "获取 / 刷新报价" }).click();
  await page.getByRole("button", { name: "确认全部付款条件" }).click();
  await page.reload();
  await expect(
    page.getByText("AWAITING_SIGNATURE", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模拟确认与执行" }).click();
  await page.getByRole("button", { name: "刷新 / 重新核验" }).click();
  await expect(
    page.getByText("VERIFIED_SUCCESS", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/payment-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("模拟身份").selectOption("recipient");
  await page.getByRole("link", { name: "02   版本审核" }).click();
  await page.locator("#invoiceSelect").selectOption({ index: 1 });
  await page.getByRole("button", { name: "核对模拟到账" }).click();
  await expect(page.getByRole("status")).toContainText("操作已保存");
  await page.getByLabel("模拟身份").selectOption("payer");
  await page.getByRole("link", { name: "04   授权对账" }).click();
  await page.locator("#invoiceSelect").selectOption({ index: 1 });
  await page.getByRole("button", { name: "授予当前版本只读访问" }).click();
  await expect(page.getByText("v1 → accountant").first()).toBeVisible();
  await page.getByLabel("模拟身份").selectOption("accountant");
  await page.getByRole("button", { name: "查看", exact: true }).first().click();
  await expect(page.locator("#disclosed")).toContainText("amountAtomic");
  await expect(page.locator("#disclosed")).not.toContainText("purpose");
  const href = await page
    .getByRole("link", { name: "导出", exact: true })
    .first()
    .getAttribute("href");
  const exported = await page.request.get(href!);
  expect(exported.ok()).toBeTruthy();
  expect(await exported.json()).not.toHaveProperty("address");
  await page.getByLabel("模拟身份").selectOption("payer");
  await page.getByRole("button", { name: "撤权", exact: true }).first().click();
  await page.getByLabel("模拟身份").selectOption("accountant");
  expect((await page.request.get(href!)).status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/disclosure-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("edit invalidates approval; interrupted timeout stays locked after reload", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("用途", { exact: true })
    .fill("Timeout fake " + Date.now());
  await page.getByRole("button", { name: "创建账单", exact: true }).click();
  await page.getByRole("button", { name: "批准当前版本" }).click();
  await expect(page.getByText("有效 · payer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "修改并创建新版本" }).click();
  await page.getByLabel("原子单位金额（整数）").fill("99000000");
  await page.getByRole("button", { name: "保存新版本" }).click();
  await expect(page.getByText("已失效", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "批准当前版本" }).click();
  await expect(page.getByText("有效 · payer", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "进入付款确认" }).click();
  await page.getByRole("button", { name: "创建支付尝试" }).click();
  await page.getByRole("button", { name: "获取 / 刷新报价" }).click();
  await page.getByRole("button", { name: "确认全部付款条件" }).click();
  await page.getByLabel("模拟执行场景").selectOption("sim:timeout");
  await page.getByRole("button", { name: "模拟确认与执行" }).click();
  await page.getByRole("button", { name: "刷新 / 重新核验" }).click();
  await expect(page.getByText("UNKNOWN", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("UNKNOWN", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建支付尝试" })).toHaveCount(
    0,
  );
});
