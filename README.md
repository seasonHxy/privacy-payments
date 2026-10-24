# 隐账 / Privacy Payments

**L0 可运行模拟原型：模拟，无真实资金移动。只使用假数据，不能用于生产。**

实现私密账单 → 不可变版本审批 → 绑定报价 → 模拟执行与服务端核验 → 收款人核对 → 逐版本、逐字段授权对账。

| 等级 | 当前状态 |
| --- | --- |
| L0 | 已实现和自动化验证；所有金额、地址、执行结果均为模拟 |
| L1 | 禁用。只有离线 NEAR receipt 检查辅助函数与合成 fixture 测试；没有真实 testUSD 付款 |
| L2 | BLOCKED。没有完整权限、可信到账/退款证据或获准交易测试条件 |

## 执行 X，看到 Y

要求 Node.js 24 LTS、npm。项目锁定依赖版本并提交 package-lock.json。

```sh
cd /workspace/privacy-payments
npm ci --cache /tmp/npm-cache
npm run build
npm start
```

在同一机器访问 **http://127.0.0.1:3000**，看到四个中文页面和常驻“模拟，无真实资金移动”提示。仅监听 loopback；没有部署公网服务。云端如需本机访问，使用平台已有的安全端口转发，不要把此演示开放到公网。

1. 默认模拟身份“付款人”。创建假账单（如 125.00），可上传最大 64 KiB 的纯文本附件。
2. 在版本审核页批准 v1；修改金额、收款地址、用途或附件会产生新版本并使旧审批失效。
3. 付款确认页创建尝试、获取报价、核对到账/支出/费用/地址/到期时间、确认条件。
4. 选择模拟正常到账并执行，再刷新核验，看到 `VERIFIED_SUCCESS`。此状态仅指模拟证据，钱包请求为 null。
5. 切换“收款人”，选择该账单，点击“核对模拟到账”。这是模拟收款方确认，不是银行或链上证明。
6. 切回付款人，在授权对账页选择账单和字段，授权会计。切换会计，只能读取/导出授权字段。
7. 切回付款人撤权。会计的新读取和下载会返回 403；已下载内容不可收回。
8. 另建假账单，选择“超时”。状态为 UNKNOWN，刷新和重启不会开放重复付款。

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

本环境使用 `/usr/bin/chromium`，可通过 `CHROMIUM_PATH` 指定已安装 Chromium；Playwright 配置为受限容器关闭浏览器沙箱，仅浏览本地假数据应用。浏览器测试使用独立 `/tmp/privacy-payments-e2e-*` 数据目录，不接触演示数据库。没有浏览器时需自行安装受支持 Chromium，再设置路径。开发热更新：`npm run dev`。

## 数据和限制

- Express 5 + TypeScript + Node 24 `node:sqlite`，前端为无框架 HTML/CSS/JS。未采用 Next.js/PostgreSQL，见架构说明。
- 首次启动创建 `data/storage.key`（随机 AES 存储密钥，**不是钱包密钥**）及加密 SQLite 数据库。`data/` 已忽略，不提交。备份/恢复必须同时保留密钥及数据库；没有密钥无法解密。
- 可以通过 `DATA_DIR`、`PORT` 更改目录和端口。`PAYMENT_MODE` 只接受 L0，设置 L1/L2 会在启动时失败。
- 固定允许资产 `mock:USD`，6 位小数，模拟网络 `mock-local`；不是 USDC，也不是 testUSD。金额 API 只接收正十进制整数字符串，BigInt 运算。
- 模拟登录可切换预置身份，**没有真正身份认证保证**。不得用它接入 L1/L2。会话为 HttpOnly、SameSite=Strict、有期限的服务端令牌；重启后需重新选择演示身份，付款状态仍持久保存。
- 存储加密和对象访问控制，不是端到端加密或服务商不可见。服务端持有解密能力。主机同时持有密钥和数据库，不抵御完整主机入侵。
- 只允许纯文本附件；不支持 PDF、图片、OCR、多租户管理 UI、生产登录、钱包连接、真实签名或真实退款。管理员无付款权，成员管理尚未实现。
- worker 在提交后及进程启动时核验模拟证据；没有独立队列或真实链轮询。UNKNOWN 支持显式重新核验，不能当失败重付。
- 没有外部 push、PR、部署、账户注册、持久授权或真实/测试网资金操作。

## 交付物

- [架构与 API](docs/ARCHITECTURE.md)
- [T0 官方接入证据与阻塞清单](docs/INTEGRATION.md)
- [隐私与信任边界](docs/PRIVACY.md)
- [测试验收报告](docs/ACCEPTANCE.md)
- [任务进度与下一阶段](docs/TASKS.md)
- [对抗性复核与修复](docs/REVIEW.md)
- [桌面截图](docs/evidence/payment-desktop.png) / [移动截图](docs/evidence/disclosure-mobile.png)

本轮开发于 2026-10-24 UTC 在空云端仓库开始（香港时间 2026-10-25）。这是赛前工作记录，不保证比赛资格；规则与最终提交由用户另行核实。仓库初始无 README、AGENTS.md 或已有代码；工作分支是环境预设的 `work`，未改动远程 main。

下载源码 ZIP 只包含源码、依赖锁文件、示例配置和文字文档，不包含截图、依赖目录、Git 历史、运行数据或密钥。`.env.example` 仅列出安全示例值，服务不会自动读取该文件。
