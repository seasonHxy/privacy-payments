import { WalletLogin } from "/wallet-client.js";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let walletLogin;
let user = "payer",
  invoices = [],
  selected = sessionStorage.getItem("invoice") || "",
  detail = null;
const money = (v) => {
  const b = BigInt(v);
  return `${b / 1000000n}.${(b % 1000000n).toString().padStart(6, "0")} 模拟 USD`;
};
async function api(path, method = "GET", body, headers = {}) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "请求失败");
  return d;
}
function message(m) {
  $("#message").textContent = m;
}
async function action(fn) {
  $("#identity").disabled = true;
  try {
    document.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await fn();
    message("操作已保存 · 模拟，无真实资金移动");
    await render();
  } catch (e) {
    message(e.message);
  } finally {
    $("#identity").disabled = false;
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}
function choose() {
  return `<label>当前账单<select id="invoiceSelect"><option value="">选择账单</option>${invoices.map((i) => `<option value="${i.id}" ${selected === i.id ? "selected" : ""}>${esc(i.payload.purpose)} · v${i.version}</option>`).join("")}</select></label>`;
}
function attachChoose() {
  if ($("#invoiceSelect"))
    $("#invoiceSelect").onchange = async (e) => {
      selected = e.target.value;
      sessionStorage.setItem("invoice", selected);
      await render();
    };
}
function pRow(k, v) {
  return `<div class="row"><span class="small">${esc(k)}</span><b>${esc(v)}</b></div>`;
}
async function render() {
  const page = location.hash.slice(1) || "invoices";
  document
    .querySelectorAll("nav a")
    .forEach((a) => a.classList.toggle("active", a.hash === "#" + page));
  $("#title").textContent =
    {
      invoices: "私密账单",
      review: "版本审核",
      payment: "付款确认",
      disclosure: "授权对账",
    }[page] || "私密账单";
  invoices = await api("/invoices");
  if (selected && !invoices.some((i) => i.id === selected)) selected = "";
  detail = selected ? await api("/invoices/" + selected) : null;
  const target = $("#content");
  if (page === "invoices") {
    target.innerHTML = `<div class="summary"><span class="small">私密账单工作台 / L0</span><strong>每一笔，先核对再确认。</strong><span class="small">账单版本不可变 · 报价限时绑定 · 会计仅见授权字段</span></div><div class="grid"><section class="card"><h2>新建模拟账单</h2>${user === "payer" ? `<form id="create"><label>用途<input name="purpose" value="设计服务 · 十月交付" required maxlength="500"></label><label>目标到账金额（6 位小数）<input name="amount" value="125.00" inputmode="decimal" required pattern="[0-9]+(\\.[0-9]{1,6})?"></label><label>模拟收款地址<input name="address" value="demo:recipient" required pattern="demo:[a-z0-9-]{1,40}"></label><label>附件（可选，仅 UTF-8 .txt，最大 64 KiB）<input name="attachment" type="file" accept=".txt,text/plain"></label><p class="small">资产：模拟 USD · 网络：mock-local<br>仅存储假数据。模拟身份不具备真实钱包权限。</p><button>创建账单</button></form>` : '<p class="empty">当前身份不可创建账单。</p>'}</section><section class="card"><h2>账单列表 <span class="tag">${invoices.length}</span></h2>${invoices.map((i) => `<div class="row"><div><b>${esc(i.payload.purpose)}</b><p class="small">${money(i.payload.amountAtomic)} · v${i.version}<br>${i.settled ? "已核验模拟结算" : "待审核 / 付款"}</p></div><button class="secondary open" data-id="${i.id}">查看</button></div>`).join("") || '<p class="empty">暂无可访问的账单。</p>'}</section></div>`;
    if ($("#create"))
      $("#create").onsubmit = (e) => {
        e.preventDefault();
        action(async () => {
          const f = new FormData(e.target);
          const value = f.get("amount");
          if (!/^\d+(\.\d{1,6})?$/.test(value))
            throw Error("请输入最多 6 位小数的正金额");
          const [whole, part = ""] = value.split(".");
          const amountAtomic = (
            BigInt(whole) * 1000000n +
            BigInt(part.padEnd(6, "0"))
          ).toString();
          const file = f.get("attachment");
          let attachment;
          if (file.size) {
            if (file.size > 65536 || !file.name.endsWith(".txt"))
              throw Error("附件须为 64 KiB 内的文本");
            attachment = {
              name: file.name,
              type: "text/plain",
              content: await file.text(),
            };
          }
          const r = await api("/invoices", "POST", {
            amountAtomic,
            asset: "mock:USD",
            network: "mock-local",
            recipient: "recipient",
            address: f.get("address"),
            purpose: f.get("purpose"),
            ...(attachment ? { attachment } : {}),
          });
          selected = r.invoiceId;
          sessionStorage.setItem("invoice", selected);
          location.hash = "review";
        });
      };
    document.querySelectorAll(".open").forEach(
      (b) =>
        (b.onclick = () => {
          selected = b.dataset.id;
          sessionStorage.setItem("invoice", selected);
          location.hash = "review";
        }),
    );
  } else if (page === "review") {
    const v = detail?.versions[detail.current - 1];
    target.innerHTML = `${choose()}${detail ? `<div class="grid"><section class="card"><h2>不可变版本 v${detail.current}</h2><p class="amount">${money(v.payload.amountAtomic)}</p>${pRow("收款方", v.payload.address)}${pRow("网络 / 资产", v.payload.network + " / " + v.payload.asset)}${pRow("用途", v.payload.purpose)}${pRow("附件", v.payload.attachment?.name || "无")}<p class="small mono">版本绑定值：${v.fingerprint}</p>${v.payload.attachment ? `<a class="button secondary" href="/api/invoices/${detail.id}/attachment?version=${detail.current}">下载文本附件</a>` : ""}${user === "payer" ? '<button id="approve">批准当前版本</button><button class="secondary" id="edit">修改并创建新版本</button><a class="button secondary" href="#payment">进入付款确认</a>' : ""}${user === "recipient" ? '<button id="ack">核对模拟到账</button>' : ""}</section><section class="card"><h2>版本与审批记录</h2>${detail.versions.map((x) => pRow("v" + x.version, `${money(x.payload.amountAtomic)} · ${x.payload.purpose}`)).join("")}${detail.approvals.map((a) => pRow("v" + a.version + " 审批", a.active ? "有效 · " + a.by : "已失效")).join("")}<p class="small">修改金额、地址或附件会使旧审批与未签名报价失效。进入签名阶段后锁定账单。</p></section></div>` : '<div class="card empty">请先创建或选择账单。</div>'}`;
    if ($("#approve"))
      $("#approve").onclick = () =>
        action(() =>
          api(`/invoices/${selected}/approvals`, "POST", {
            version: detail.current,
          }),
        );
    if ($("#ack"))
      $("#ack").onclick = () =>
        action(() => api(`/invoices/${selected}/acknowledgement`, "POST", {}));
    if ($("#edit"))
      $("#edit").onclick = () => {
        if ($("#editForm")) return;
        $("#edit").insertAdjacentHTML(
          "afterend",
          `<form id="editForm"><h3>创建新版本</h3><label>原子单位金额（整数）<input name="amountAtomic" value="${esc(v.payload.amountAtomic)}" required pattern="[1-9][0-9]{0,77}"></label><label>新收款地址<input name="address" value="${esc(v.payload.address)}" required></label><label>新用途<input name="purpose" value="${esc(v.payload.purpose)}" required></label><label>替换文本附件<input type="file" name="attachment" accept=".txt,text/plain"></label><label class="check"><input type="checkbox" name="removeAttachment">移除原附件</label><button>保存新版本</button></form>`,
        );
        $("#editForm").onsubmit = (e) => {
          e.preventDefault();
          action(async () => {
            const f = new FormData(e.target);
            const p = {
              ...v.payload,
              amountAtomic: f.get("amountAtomic"),
              address: f.get("address"),
              purpose: f.get("purpose"),
            };
            if (f.get("removeAttachment")) delete p.attachment;
            const file = f.get("attachment");
            if (file.size) {
              if (file.size > 65536 || !file.name.endsWith(".txt"))
                throw Error("附件须为 64 KiB 内的文本");
              p.attachment = {
                name: file.name,
                type: "text/plain",
                content: await file.text(),
              };
            }
            await api("/invoices/" + selected, "PATCH", {
              expectedVersion: detail.current,
              payload: p,
            });
          });
        };
      };
  } else if (page === "payment") {
    const a = detail?.attempts.at(-1),
      q = a?.quote;
    target.innerHTML = `${choose()}<div class="grid"><section class="card"><h2>实际付款条件 <span class="tag">L0 模拟</span></h2>${q ? `${pRow("目标到账", money(q.outputAtomic))}${pRow("实际支出上限", money(q.inputAtomic))}${pRow("服务费 / 网络费", money(q.serviceFeeAtomic) + " / " + money(q.networkFeeAtomic))}${pRow("收款地址", q.recipient)}${pRow("退款目的地", q.refundTo)}${pRow("网络 / 资产", q.network + " / " + q.asset)}${pRow("报价到期", new Date(q.expiresAt).toLocaleString())}<p class="small">${esc(q.refundPolicy)}</p><p class="small mono">报价绑定值：${q.fingerprint}</p>` : '<p class="empty">批准账单后获取绑定报价。</p>'}${detail && user === "payer" ? `${!a || ["FAILED_NO_TRANSFER", "USER_REJECTED"].includes(a.state) ? '<button id="start">创建支付尝试</button>' : ""}${a && ["CREATED", "QUOTED"].includes(a.state) ? '<button id="quote">获取 / 刷新报价</button>' : ""}${a?.state === "QUOTED" ? '<button id="confirm">确认全部付款条件</button>' : ""}${a?.state === "AWAITING_SIGNATURE" ? '<label>模拟执行场景<select id="scenario"><option value="sim:success">正常到账</option><option value="sim:timeout">超时 / UNKNOWN</option><option value="sim:underpaid">少付 / 待核对</option><option value="sim:failed">明确未转账</option><option value="sim:refund-partial">部分退款 / 待核对</option></select></label><button id="simulate">模拟确认与执行</button><button id="reject" class="secondary">模拟拒签</button>' : ""}` : ""}</section><section class="card"><h2>核验进度</h2><span class="tag">${a?.state || "尚无支付尝试"}</span><p class="small">执行标识只触发服务端核验，不代表成功。刷新页面会恢复同一尝试。</p>${a ? `<p class="small mono">尝试 ${a.id}<br>状态版本 ${a.revision}<br>${esc(a.reason || "")}</p><button class="secondary" id="refresh">刷新 / 重新核验</button>` : ""}${a?.evidence ? `<h3>证据来源</h3><pre>${esc(JSON.stringify(a.evidence, null, 2))}</pre>` : ""}<p class="small">没有钱包签名或链上交易。L1 与 L2 不会回退为模拟成功。</p></section></div>`;
    if ($("#start"))
      $("#start").onclick = () =>
        action(() =>
          api(
            `/invoices/${selected}/payment-attempts`,
            "POST",
            { version: detail.current },
            { "Idempotency-Key": crypto.randomUUID() },
          ),
        );
    for (const [id, fn] of Object.entries({
      quote: () => api(`/payment-attempts/${a.id}/quote`, "POST", {}),
      confirm: () =>
        api(`/payment-attempts/${a.id}/confirm`, "POST", {
          version: detail.current,
          quoteFingerprint: q.fingerprint,
        }),
      simulate: async () => {
        await api(`/payment-attempts/${a.id}/prepare-signing`, "POST", {});
        await api(`/payment-attempts/${a.id}/execution-reference`, "POST", {
          reference: $("#scenario").value,
        });
      },
      reject: () => api(`/payment-attempts/${a.id}/reject`, "POST", {}),
      refresh: () => api(`/payment-attempts/${a.id}/recheck`, "POST", {}),
    })) {
      if ($("#" + id)) $("#" + id).onclick = () => action(fn);
    }
  } else if (page === "disclosure") {
    const grants = await api("/disclosures");
    target.innerHTML = `<div class="grid"><section class="card"><h2>按单据授权查看</h2>${user === "payer" ? `${choose()}<p class="small">接收人：指定会计 accountant · 只读 · 24 小时后到期</p>${["amountAtomic", "asset", "network", "purpose", "address", "evidence"].map((f, i) => `<label class="check"><input type="checkbox" name="field" value="${f}" ${i < 2 ? "checked" : ""}>${{ amountAtomic: "金额", asset: "资产", network: "网络", purpose: "用途", address: "地址", evidence: "核验证据摘要" }[f]}</label>`).join("")}<p><button id="grant">授予当前版本只读访问</button></p>` : '<p class="small">会计只能查看明确授予的字段，不能读取完整账单，也不能付款。</p>'}<p class="small">撤销仅阻止未来访问，无法收回已下载的内容。披露不授予花费权限。</p></section><section class="card"><h2>披露记录</h2>${grants.map((g) => `<div class="row"><div><b>v${g.version} → ${g.recipient}</b><p class="small">${esc(g.fields.join(", "))}<br>${g.revokedAt ? "已撤权" : new Date(g.expiresAt).toLocaleString() + " 到期"}</p></div>${user === "payer" ? `<button class="secondary revoke" data-id="${g.id}">撤权</button>` : `<button class="secondary read" data-id="${g.id}">查看</button><a class="button secondary" href="/api/disclosures/${g.id}/export">导出</a>`}</div>`).join("") || '<p class="empty">暂无披露记录。</p>'}<pre id="disclosed" hidden></pre></section></div>`;
    if ($("#grant"))
      $("#grant").onclick = () =>
        action(() => {
          if (!detail) throw Error("请先选择账单");
          return api("/disclosures", "POST", {
            invoiceId: selected,
            version: detail.current,
            recipient: "accountant",
            fields: [...document.querySelectorAll("[name=field]:checked")].map(
              (e) => e.value,
            ),
            expiresAt: Date.now() + 86400000,
          });
        });
    document
      .querySelectorAll(".revoke")
      .forEach(
        (b) =>
          (b.onclick = () =>
            action(() => api("/disclosures/" + b.dataset.id, "DELETE", {}))),
      );
    document.querySelectorAll(".read").forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            $("#disclosed").textContent = JSON.stringify(
              await api("/disclosures/" + b.dataset.id),
              null,
              2,
            );
            $("#disclosed").hidden = false;
          } catch (e) {
            message(e.message);
          }
        }),
    );
  }
  attachChoose();
}
$("#identity").onchange = () =>
  action(async () => {
    user = $("#identity").value;
    await api("/demo/session", "POST", { user });
    selected = "";
  });
window.onhashchange = () => render().catch((e) => message(e.message));
(async () => {
  const authConfig = await api("/auth/config");
  if (authConfig.paymentMode === "L1") {
    $(".mode").textContent =
      "L1 公开测试网 · 仅准备待签请求，未执行交易 · L2 BLOCKED";
    $("aside .muted").textContent = "TESTNET WORKSPACE";
    $("footer").textContent =
      "testUSD 无美元价值 · 测试网账户和金额公开 · 不收集私钥或助记词";
  }
  if (authConfig.mode === "NEP413") {
    $("#identity").closest("label").hidden = true;
    walletLogin = new WalletLogin(authConfig.wallet, api);
    $("#logout").hidden = false;
    $("#logout").onclick = async () => {
      try {
        await walletLogin.logout();
        location.reload();
      } catch (e) {
        message(e.message);
      }
    };
  }
  try {
    const me = await api("/me");
    if (authConfig.paymentMode === "L1") {
      location.replace("/l1.html");
      return;
    }
    user = me.user;
    $("#identity").value = user;
  } catch {
    if (authConfig.mode === "NEP413") {
      $("#title").textContent = "账户登录";
      $("#content").innerHTML =
        `<section class="card"><h2>需要钱包登录</h2><p class="small">NEP-413 登录只验证账户控制权，不授权付款或添加访问密钥。</p>${authConfig.wallet?.enabled ? `<form id="walletLogin"><label>已配置的测试网账户<input name="accountId" required maxlength="64" autocomplete="off"></label><p class="small">钱包：${esc(authConfig.wallet.walletId)} · testnet · 浏览器扩展连接</p><button>连接钱包并签署登录消息</button></form>` : "<p>待配置：请确认钱包、公开测试网账户及登录域名。真实登录配置缺失，不会切换为演示身份。</p>"}</section>`;
      if ($("#walletLogin"))
        $("#walletLogin").onsubmit = async (event) => {
          event.preventDefault();
          const button = event.target.querySelector("button");
          button.disabled = true;
          message("请在钱包核对登录消息；这不是付款请求。");
          try {
            const accountId = new FormData(event.target).get("accountId");
            await walletLogin.login(accountId);
            location.reload();
          } catch (e) {
            message(e.message);
            button.disabled = false;
          }
        };
      return;
    }
    await api("/demo/session", "POST", { user });
  }
  await render();
})().catch((e) => message(e.message));
