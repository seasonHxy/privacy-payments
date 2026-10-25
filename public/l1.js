const $ = (id) => document.getElementById(id);
let invoices = [];
let current;
let busy = false;
let user;
let settings;
let createKey = crypto.randomUUID();
const writable = () => user === "payer";
const pretty = (value) => JSON.stringify(value, null, 2);
async function api(path, body, headers = {}, method = "POST") {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : method,
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
  for (const control of document.querySelectorAll(
    "button, input, select, textarea",
  ))
    control.disabled = busy;
  $("create-form").hidden = !writable();
  $("grant-form").hidden = !writable() || !current || !settings?.accountant;
  $("edit-form").hidden =
    !current ||
    !writable() ||
    !["CREATED", "APPROVED", "QUOTED", "CONFIRMED"].includes(current.state);
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
    $("edit-amount").value = current.amountAtomic;
    $("edit-purpose").value = current.purpose;
    $("edit-attachment").value = current.attachment?.content || "";
    $("version-history").textContent = pretty(current.versions || []);
    for (const id of ["grant-version", "attachment-version"]) {
      const selected = $(id).value;
      $(id).replaceChildren();
      for (const v of current.versions || [{ version: current.version }])
        $(id).append(new Option(`v${v.version}`, String(v.version)));
      if ([...$(id).options].some((o) => o.value === selected))
        $(id).value = selected;
      else $(id).value = String(current.version);
    }
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
      {
        amountAtomic: $("amount").value,
        purpose: $("purpose").value,
        ...attachmentInput("create-attachment"),
      },
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
function attachmentInput(id) {
  const content = $(id).value;
  return content
    ? { attachment: { name: "invoice-note.txt", type: "text/plain", content } }
    : {};
}
async function download(path, name) {
  const r = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!r.ok) throw Error((await r.json()).error || "DOWNLOAD_FORBIDDEN");
  const url = URL.createObjectURL(await r.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("edit-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void run(async () => {
    const id = current.id;
    await api(
      `/api/l1/invoices/${encodeURIComponent(id)}`,
      {
        expectedVersion: current.version,
        payload: {
          amountAtomic: $("edit-amount").value,
          purpose: $("edit-purpose").value,
          ...attachmentInput("edit-attachment"),
        },
      },
      {},
      "PATCH",
    );
    await refresh(id);
    message("已保存不可变新版本，旧批准与报价已失效。");
  });
});
$("owner-attachment").addEventListener(
  "click",
  () =>
    void run(() =>
      download(
        `/api/l1/invoices/${encodeURIComponent(current.id)}/attachment?version=${encodeURIComponent($("attachment-version").value)}`,
        "l1-invoice-note.txt",
      ),
    ),
);
const fieldLabels = {
  amountAtomic: "原子金额",
  purpose: "用途",
  asset: "资产",
  network: "网络",
  payer: "付款账户",
  recipient: "收款账户",
  attachment: "附件及下载",
  settlement: "核验摘要",
};
for (const [field, label] of Object.entries(fieldLabels)) {
  const el = document.createElement("label"),
    input = document.createElement("input");
  input.type = "checkbox";
  input.name = "disclosure-field";
  input.value = field;
  el.append(input, document.createTextNode(label));
  $("grant-fields").append(el);
}
async function refreshGrants() {
  $("disclosure-output").textContent = "";
  const grants = await api("/api/l1/disclosures");
  $("grants").replaceChildren();
  for (const grant of grants) {
    const row = document.createElement("section"),
      summary = document.createElement("p");
    summary.textContent = `${grant.invoiceId} · v${grant.version} · ${grant.fields.join(", ")} · ${grant.revokedAt !== undefined ? "已撤权" : new Date(grant.expiresAt).toLocaleString()}`;
    row.append(summary);
    const button = (label, action) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => void run(action));
      row.append(b);
    };
    const path = `/api/l1/disclosures/${encodeURIComponent(grant.id)}`;
    if (user === "accountant") {
      button("读取授权字段", async () => {
        $("disclosure-output").textContent = "";
        $("disclosure-output").textContent = pretty(await api(path));
      });
      button("导出授权字段", () =>
        download(path + "/export", "l1-disclosure.json"),
      );
      if (grant.fields.includes("attachment"))
        button("下载授权附件", () =>
          download(path + "/attachment", "l1-disclosed-note.txt"),
        );
    } else if (grant.revokedAt === undefined)
      button("撤销此授权", async () => {
        await api(path, {}, {}, "DELETE");
        await refreshGrants();
      });
    $("grants").append(row);
  }
}
$("grant-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void run(async () => {
    await api("/api/l1/disclosures", {
      invoiceId: current.id,
      version: Number($("grant-version").value),
      recipient: $("grant-recipient").value,
      fields: [
        ...document.querySelectorAll('input[name="disclosure-field"]:checked'),
      ].map((el) => el.value),
      expiresAt: Date.now() + Number($("grant-minutes").value) * 60000,
    });
    await refreshGrants();
    message("只读授权已保存；没有授予花费权限。");
  });
});
$("refresh-grants").addEventListener(
  "click",
  () => void run(() => refreshGrants()),
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
  settings = await api("/api/l1/settings");
  details.textContent = pretty(settings);
  $("disclosure-workspace").hidden = !["payer", "accountant"].includes(user);
  $("grant-recipient").value = settings.accountant || "";
  if (user !== "accountant") {
    $("workspace").hidden = false;
    await refresh();
  }
  if (["payer", "accountant"].includes(user)) await refreshGrants();
});
