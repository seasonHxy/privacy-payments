import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signingFixture } from "../helpers/near-fixtures.js";
import { verifyNep413 } from "../../src/nep413.js";

for (const scenario of [
  "success",
  "reject",
  "wrong-account",
  "forged-frame",
  "interrupted",
] as const) {
  test(`official injected SDK NEP-413 browser protocol: ${scenario}`, async ({
    page,
  }) => {
    const fixture = signingFixture();
    const challenge = {
      challengeId: randomUUID(),
      accountId: "payer-fixture.testnet",
      nonceBase64: Buffer.alloc(32, 7).toString("base64"),
      state: "s".repeat(43),
      message: "Test-only login purpose; no transaction authorization",
      recipient: "http://127.0.0.1:3100",
      expiresAt: Date.now() + 300000,
    };
    let verified = false;
    let verifyCount = 0;
    const calls: { method: string; data: unknown }[] = [];
    await page.exposeFunction(
      "fixtureWalletCall",
      (method: string, data: unknown) => {
        calls.push({ method, data });
      },
    );
    await page.exposeFunction(
      "fixtureWalletSignature",
      (p: {
        message: string;
        recipient: string;
        nonce: number[];
        network: string;
        signerId: string;
      }) => {
        expect(p.network).toBe("testnet");
        expect(p.signerId).toBe(challenge.accountId);
        expect(p.nonce).toEqual([...Buffer.alloc(32, 7)]);
        expect(p.message).toBe(challenge.message);
        expect(p.recipient).toBe(challenge.recipient);
        return {
          accountId: challenge.accountId,
          publicKey: fixture.publicKey,
          signature: fixture.sign({
            ...p,
            nonceBase64: Buffer.from(p.nonce).toString("base64"),
          }),
        };
      },
    );
    await page.addInitScript(
      ({ scenario }) => {
        const bridge = window as unknown as {
          fixtureWalletCall: (method: string, data: unknown) => Promise<void>;
          fixtureWalletSignature: (p: unknown) => Promise<unknown>;
        };
        window.addEventListener("near-selector-ready", () => {
          if (scenario === "forged-frame") {
            window.postMessage(
              {
                type: "near-wallet-injected",
                manifest: {
                  id: "fixture-injected",
                  type: "injected",
                  features: {
                    testnet: true,
                    signMessage: true,
                    signInWithoutAddKey: true,
                  },
                },
              },
              location.origin,
            );
            return;
          }
          window.dispatchEvent(
            new CustomEvent("near-wallet-injected", {
              detail: {
                manifest: {
                  id: "fixture-injected",
                  type: "injected",
                  features: {
                    testnet: true,
                    signMessage: true,
                    signInWithoutAddKey: true,
                  },
                },
                signIn: async (data: unknown) => {
                  await bridge.fixtureWalletCall("signIn", data);
                  return [{ accountId: "payer-fixture.testnet" }];
                },
                getAccounts: async () => [
                  {
                    accountId:
                      scenario === "wrong-account"
                        ? "other-fixture.testnet"
                        : "payer-fixture.testnet",
                  },
                ],
                signMessage: async (p: { nonce: Uint8Array }) => {
                  if (scenario === "reject") throw Error("USER_REJECTED");
                  if (scenario === "interrupted") return new Promise(() => {});
                  return bridge.fixtureWalletSignature({
                    ...p,
                    nonce: [...p.nonce],
                  });
                },
                signOut: async () => {},
                signAndSendTransaction: async () => {
                  throw Error("FORBIDDEN_TRANSACTION_CALL");
                },
              },
            }),
          );
        });
      },
      { scenario },
    );
    await page.route("**/api/auth/config", (r) =>
      r.fulfill({
        json: {
          mode: "NEP413",
          paymentMode: "L0",
          wallet: {
            enabled: true,
            network: "testnet",
            transport: "injected",
            walletId: "fixture-injected",
          },
        },
      }),
    );
    await page.route("**/api/me", (r) =>
      verified
        ? r.fulfill({ json: { user: "payer" } })
        : r.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
    );
    await page.route("**/api/auth/challenge", async (r) => {
      expect(r.request().postDataJSON()).toEqual({
        accountId: challenge.accountId,
      });
      await r.fulfill({ json: challenge });
    });
    await page.route("**/api/auth/verify", async (r) => {
      verifyCount++;
      const body = r.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(
        ["challengeId", "state", "accountId", "publicKey", "signature"].sort(),
      );
      expect(body.challengeId).toBe(challenge.challengeId);
      expect(body.state).toBe(challenge.state);
      expect(
        verifyNep413(
          {
            message: challenge.message,
            recipient: challenge.recipient,
            nonce: Buffer.from(challenge.nonceBase64, "base64"),
          },
          body.publicKey,
          body.signature,
        ),
      ).toBe(true);
      verified = true;
      await r.fulfill({ json: { user: "payer", authentication: "NEP413" } });
    });
    await page.route("**/api/invoices", (r) => r.fulfill({ json: [] }));
    await page.goto("/");
    await page.getByLabel("已配置的测试网账户").fill(challenge.accountId);
    await page.getByRole("button", { name: "连接钱包并签署登录消息" }).click();
    if (scenario === "success")
      await expect(
        page.getByRole("heading", { name: "新建模拟账单" }),
      ).toBeVisible();
    else if (scenario === "interrupted") {
      await expect(
        page.getByRole("button", { name: "连接钱包并签署登录消息" }),
      ).toBeDisabled();
      await expect.poll(() => calls.length).toBe(1);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "需要钱包登录" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "连接钱包并签署登录消息" }),
      ).toBeEnabled();
    } else
      await expect(page.getByRole("status")).toHaveText(
        scenario === "reject"
          ? "USER_REJECTED"
          : scenario === "forged-frame"
            ? "CONFIGURED_INJECTED_WALLET_NOT_AVAILABLE"
            : "WALLET_ACCOUNT_MISMATCH",
      );
    expect(verifyCount).toBe(scenario === "success" ? 1 : 0);
    expect(calls).toEqual(
      scenario === "forged-frame"
        ? []
        : [{ method: "signIn", data: { network: "testnet" } }],
    );
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    await expect(page.getByLabel("模拟身份")).toBeHidden();
  });
}
