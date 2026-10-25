// Only official NEAR Connect injected transport. Never request access keys or send transactions.
export class WalletLogin {
  constructor(config, api, loadSdk = () => import("/generated/wallet-sdk.js")) {
    this.config = config;
    this.api = api;
    this.loadSdk = loadSdk;
    this.busy = false;
  }
  async login(accountId) {
    if (this.busy) throw Error("WALLET_LOGIN_PENDING");
    if (
      !this.config?.enabled ||
      this.config.network !== "testnet" ||
      this.config.transport !== "injected" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(this.config.walletId)
    )
      throw Error("WALLET_CONFIGURATION_REQUIRED");
    this.busy = true;
    try {
      const challenge = await this.api("/auth/challenge", "POST", {
        accountId,
      });
      if (
        challenge.recipient !== location.origin ||
        challenge.expiresAt <= Date.now()
      )
        throw Error("CHALLENGE_ORIGIN_OR_EXPIRY");
      const nonce = Uint8Array.from(atob(challenge.nonceBase64), (c) =>
        c.charCodeAt(0),
      );
      if (nonce.length !== 32) throw Error("INVALID_CHALLENGE_NONCE");
      if (!this.connector) {
        const { NearConnector, InjectedWallet } = await this.loadSdk();
        this.InjectedWallet = InjectedWallet;
        const memory = new Map();
        this.connector = new NearConnector({
          network: "testnet",
          autoConnect: false,
          manifest: { wallets: [], version: "1.0.0" },
          features: {
            signMessage: true,
            signInWithoutAddKey: true,
            testnet: true,
          },
          storage: {
            get: async (k) => memory.get(k) ?? null,
            set: async (k, v) => {
              memory.set(k, v);
            },
            remove: async (k) => {
              memory.delete(k);
            },
          },
        });
      }
      await this.connector.whenManifestLoaded;
      const available = this.connector.availableWallets.find(
        (w) =>
          w.manifest.id === this.config.walletId &&
          w.manifest.type === "injected" &&
          w instanceof this.InjectedWallet,
      );
      if (!available) throw Error("CONFIGURED_INJECTED_WALLET_NOT_AVAILABLE");
      // Keep the checked object: SDK connect() resolves mutable walletId again after await.
      // A postMessage ParentFrameWallet must not replace the selected transport.
      const wallet = available;
      await wallet.signIn({ network: "testnet" });
      this.activeWallet = wallet;
      const accounts = await wallet.getAccounts({ network: "testnet" });
      if (!accounts.some((a) => a.accountId === accountId))
        throw Error("WALLET_ACCOUNT_MISMATCH");
      if (challenge.expiresAt <= Date.now()) throw Error("CHALLENGE_EXPIRED");
      const signed = await wallet.signMessage({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce,
        signerId: accountId,
        network: "testnet",
      });
      if (
        !signed ||
        signed.accountId !== accountId ||
        typeof signed.publicKey !== "string" ||
        typeof signed.signature !== "string"
      )
        throw Error("WALLET_RESPONSE_MISMATCH");
      return await this.api("/auth/verify", "POST", {
        challengeId: challenge.challengeId,
        state: challenge.state,
        accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
      });
    } finally {
      this.busy = false;
    }
  }
  async logout() {
    // Invalidate server session first even if an extension refuses disconnect.
    await this.api("/auth/logout", "POST", {});
    if (this.activeWallet)
      await this.activeWallet.signOut({ network: "testnet" }).catch(() => {});
  }
}
