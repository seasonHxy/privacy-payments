const $ = (id) => document.getElementById(id);
let invoices = [];
let current;
let busy = false;
let user;
let createKey = crypto.randomUUID();
const writable = () => user === "payer";
const pretty = (value) => JSON.stringify(value, null, 2);
async function api(path, body, headers = {}) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "REQUEST_FAILED");
  return data;
}
function message(text) {
  $("message").textContent = text;
}
function controls() {
  for (const control of document.querySelectorAll("button, input, select"))
    control.disabled = busy;
  $("create-form").hidden = !writable();
  if (!current) return;
  const state = current.state;
  $("approve").disabled = busy || !writable() || state !== "CREATED";
  $("quote").disabled =
    busy || !writable() || !["APPROVED", "QUOTED", "CONFIRMED"].includes(state);
  $("confirm").disabled = busy || !writable() || state !== "QUOTED";
  $("prepare").disabled =
    busy || !writable() || !["CONFIRMED", "AWAITING_SIGNATURE"].includes(state);
  $("reference-form").hidden =
    !writable() ||
    !["AWAITING_SIGNATURE", "SUBMITTED", "UNKNOWN"].includes(state);
  $("recheck").disabled = busy || !current.reference;
  $("acknowledge").disabled =
    busy ||
    user !== "recipient" ||
    state !== "VERIFIED_SUCCESS" ||
    Boolean(current.acknowledgedAt);
}
function render() {
  $("detail").hidden = !current;
  if (current) {
    $("invoice").textContent = pretty({
      id: current.id,
      mode: current.mode,
      version: current.version,
      state: current.state,
      amountAtomic: current.amountAtomic,
      purpose: current.purpose,
      approval: current.approval,
    });
    $("quote-data").textContent = current.quote
      ? pretty(current.quote)
      : "尚无报价";
    $("signing").textContent =
      [
        "AWAITING_SIGNATURE",
        "SUBMITTED",
        "UNKNOWN",
        "VERIFIED_SUCCESS",
        "REVIEW_REQUIRED",
      ].includes(current.state) && current.quote?.request
        ? pretty(current.quote.request)
        : "尚未生成待签请求";
    $("evidence").textContent = pretty({
      state: current.state,
      reference: current.reference,
      evidence: current.evidence,
      acknowledgedAt: current.acknowledgedAt,
    });
    $("uncertain").hidden = !["SUBMITTED", "UNKNOWN"].includes(current.state);
  }
  controls();
}
async function refresh(selected = current?.id || location.hash.slice(1)) {
  invoices = await api("/api/l1/invoices");
  const select = $("invoice-select");
  select.replaceChildren(new Option("选择账单", ""));
  for (const invoice of invoices)
    select.append(
      new Option(`${invoice.purpose} · ${invoice.state}`, invoice.id),
    );
  current = invoices.find((invoice) => invoice.id === selected);
  select.value = current?.id || "";
  if (current)
    current = await api(`/api/l1/invoices/${encodeURIComponent(current.id)}`);
  render();
}
async function run(action) {
  if (busy) return;
  busy = true;
  controls();
  message("");
  try {
    await action();
  } catch (error) {
    message(
      `未完成：${error.message}。若请求中断，请刷新已保存状态；不要重复付款。`,
    );
  } finally {
    busy = false;
    render();
  }
}
async function change(action, body = {}) {
  if (!current) throw new Error("SELECT_INVOICE_REQUIRED");
  const id = current.id;
  await api(`/api/l1/invoices/${encodeURIComponent(id)}/${action}`, body);
  await refresh(id);
  message("已保存。此页面未执行任何钱包转账。");
}
$("logout").addEventListener(
  "click",
  () =>
    void run(async () => {
      await api("/api/auth/logout", {});
      location.replace("/");
    }),
);
$("create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const invoice = await api(
      "/api/l1/invoices",
      { amountAtomic: $("amount").value, purpose: $("purpose").value },
      { "Idempotency-Key": createKey },
    );
    createKey = crypto.randomUUID();
    history.replaceState(null, "", `#${encodeURIComponent(invoice.id)}`);
    await refresh(invoice.id);
    message("已创建 L1 测试账单。请核对版本与配置中的收款方。");
  });
});
$("invoice-select").addEventListener(
  "change",
  () =>
    void run(async () => {
      history.replaceState(
        null,
        "",
        `#${encodeURIComponent($("invoice-select").value)}`,
      );
      await refresh($("invoice-select").value);
    }),
);
$("refresh").addEventListener("click", () => void run(() => refresh()));
$("approve").addEventListener(
  "click",
  () => void run(() => change("approve", { version: current.version })),
);
$("quote").addEventListener("click", () => void run(() => change("quote")));
$("confirm").addEventListener(
  "click",
  () =>
    void run(() => {
      if (!current?.quote || current.quote.expiresAt <= Date.now())
        throw new Error("QUOTE_EXPIRED");
      return change("confirm", {
        version: current.version,
        quoteFingerprint: current.quote.fingerprint,
      });
    }),
);
$("prepare").addEventListener(
  "click",
  () => void run(() => change("prepare-signing")),
);
$("reference-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(() =>
    change("execution-reference", { reference: $("reference").value }),
  );
});
$("recheck").addEventListener("click", () => void run(() => change("recheck")));
$("acknowledge").addEventListener(
  "click",
  () => void run(() => change("acknowledgement")),
);
await run(async () => {
  const config = await api("/api/l1/config");
  $("configuration").replaceChildren();
  const title = document.createElement("h2");
  title.textContent =
    config.enabled === true ? "测试网配置" : "L1 待配置 / 已禁用";
  const details = document.createElement("pre");
  details.textContent = pretty(config);
  $("configuration").append(title, details);
  if (config.enabled !== true) {
    message(
      "需核实 testUSD 合约、精度、网络锚点、双方账户及真实登录配置。不会使用模拟通道替代 L1。",
    );
    return;
  }
  const me = await api("/api/me");
  if (me.authentication !== "NEP413") throw new Error("REAL_AUTH_REQUIRED");
  user = me.user;
  $("logout").hidden = false;
  const settings = await api("/api/l1/settings");
  details.textContent = pretty(settings);
  $("workspace").hidden = false;
  await refresh();
});
