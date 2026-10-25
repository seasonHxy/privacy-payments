// Cross-tab messages contain no identity, invoice, or token data.
export class SessionGuard {
  constructor(clear) {
    this.clear = clear;
    this.user = undefined;
    this.epoch = 0;
    this.channel = new BroadcastChannel("privacy-payments-session");
    this.channel.onmessage = () => this.invalidate();
    window.addEventListener("focus", () => void this.check());
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) this.invalidate();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.check();
    });
  }
  bind(user) {
    this.user = user;
  }
  invalidate() {
    this.epoch++;
    this.user = undefined;
    this.clear();
  }
  changed() {
    this.channel.postMessage("changed");
  }
  async check() {
    if (!this.user || this.checking) return;
    this.checking = true;
    const epoch = this.epoch;
    try {
      const r = await fetch("/api/me", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const me = await r.json();
      if (epoch === this.epoch && (!r.ok || me.user !== this.user))
        this.invalidate();
    } catch {
      if (epoch === this.epoch) this.invalidate();
    } finally {
      this.checking = false;
    }
  }
}
