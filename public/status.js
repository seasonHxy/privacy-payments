try {
  const r = await fetch("/api/configuration-status", { cache: "no-store" });
  if (!r.ok) throw Error("STATUS_UNAVAILABLE");
  const data = await r.json();
  for (const section of ["levels", "checks"])
    for (const item of data[section]) {
      const p = document.createElement("p");
      p.textContent = `${item.name}：${item.state} — ${item.note}`;
      document.getElementById(section).append(p);
    }
  document.getElementById("status").textContent =
    "状态只说明当前服务器配置；没有暴露账户、端点、密钥或本地路径。";
} catch {
  document.getElementById("status").textContent =
    "暂时无法读取配置状态，请确认服务已启动后刷新。";
}
