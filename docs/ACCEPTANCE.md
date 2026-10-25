# L0 验收报告

验证日期：2026-10-25 UTC（包含前轮记录）。环境 Node v24.19.0 / Linux / 系统 Chromium。全部输入均为假账单、模拟地址或离线合成 fixture。初始仓库为空；未触碰 quant-trading-agent。

## 结果分类

| 检查 | 结果 | 实际证据 |
| --- | --- | --- |
| npm run lint | PASS | ESLint src/tests，无错误；初轮未使用参数问题已修复 |
| npm run typecheck | PASS | 严格检查服务端、测试和 Playwright 配置 |
| npm test | PASS | 28 tests，28 pass，0 fail，0 skipped |
| npm run build | PASS | TypeScript 编译至 dist；npm start 启动的是构建结果 |
| npm run test:e2e | PASS | 3/3 Chromium 浏览器测试，约 4.9 秒；完整闭环、刷新恢复、修改和 UNKNOWN 锁定 |
| npm audit --omit=dev | PASS | 当次 registry 审计报告 0 vulnerabilities；不是安全审计证明 |
| 桌面/移动 UI | PASS | 1280 宽桌面、390×844 移动；移动没有横向溢出，主流程没有 pageerror；截图在 evidence/ |
| Playwright 自带浏览器安装 | BLOCKED（已替代） | CDN 返回 403 Domain forbidden；改用已安装 /usr/bin/chromium 完成测试，没有扩大权限 |
| L1 真实 testUSD 付款/核验 | NOT RUN / 禁用 | 无真实账户、钱包、资产合约/精度核实或资金操作授权；只有离线 helper 测试 |
| L2 保密付款/退款 | BLOCKED / 禁用 | 完整历史邀请权限、真实收款和退款证据、授权条件缺失 |
| PostgreSQL 关系持久化、迁移、行锁、CAS | PASS | 实际 PostgreSQL 18.6；18 个子场景，Node 含父测试计数 20/20；另有 3/3 PostgreSQL 浏览器 E2E |
| 真实账户/钱包登录互通、独立网络 worker、真实钱包付款 | NOT RUN / 未验收 | NEP-413服务端会话已实现并通过mock+PostgreSQL测试；未连接真实账户或钱包 |
| 公开推送、PR、部署、比赛提交 | NOT RUN | 用户限制；未执行 |

最终运行的检查没有未解决失败项。初始 npm 缓存目录不可写，改用 `/tmp/npm-cache` 后安装成功；未申请越权。浏览器 CDN 失败不是浏览器测试通过的依据，测试实际使用系统 Chromium。

## 十二组场景记录

下表的预期和实际只在注明模式范围内成立，不能推广为真实付款验收。详细可执行步骤和断言位于 `tests/domain.test.ts`、`tests/api.test.ts`；对应编号 01–12。

| 组 | 模式 / 输入 | 步骤 | 预期 | 实际 / 证据 |
| --- | --- | --- | --- | --- |
| 01 | L0，125000000 atomic 假设计账单 | 创建→批准→报价→确认→记录 sim:success→核验→收款人确认→授权金额和证据摘要 | 只有 verifier 能结清；会计见选定字段 | PASS；VERIFIED_SUCCESS；摘要含收款确认但不泄漏地址/用途，禁止再次付款 |
| 02 | L0，匿名、other 工作区、其他收款人、viewer、admin | HTTP 无会话读取；换身份读对象和批准 | 401/403/404；admin 不自带支出权 | PASS；HTTP 与域对象断言 |
| 03 | L0，分别改金额/地址/附件 | 批准旧版及报价→PATCH 新版→确认旧报价 | 旧审批失效，旧报价不能执行，历史不变 | PASS；3 个独立变更及 expectedVersion 冲突；浏览器另测金额修改 |
| 04 | L0，8 个并发同键请求及独立 DB 连接 | Promise.all HTTP 请求；另一个连接创建第二尝试 | 一个 attempt ID；不同键不能产生第二活动尝试 | PASS；8 个响应同 ID，冲突返回 409。另有新增 6 个独立进程同时竞争测试：恰好一个 CREATED、五个 ACTIVE_ATTEMPT_EXISTS；不是长期压力测试 |
| 05 | L0，同键同/异参数 | 重用原键；修改 version/mode | 同参数复用，异参数冲突 | PASS；ID 相同 / IDEMPOTENCY_CONFLICT |
| 06 | L0，时钟前移、伪造 fingerprint、新报价 | 过期确认；改变绑定；重新报价；签名后修改 | 过期及绑定不一致拒绝，签名阶段锁定 | PASS；QUOTE_EXPIRED、QUOTE_BINDING_MISMATCH、PAYMENT_LOCKED |
| 07 | L0，拒签、timeout、持久 SUBMITTED | 拒签释放；timeout 重查；关闭重开 DB 并 recover | UNKNOWN 不重付；重启恢复同一 attempt；重复恢复不再次结算 | PASS；状态/revision 断言；浏览器刷新 UNKNOWN 后无创建按钮 |
| 08 | L0 + L1 离线 fixture，错链/币/人/金额/失败/finality | 扰动证据字段；只有 hash；失败 receipt；少付场景 | 不能结清 | PASS；L0 mismatch 为 false/REVIEW_REQUIRED；L1 返回 UNKNOWN/REVIEW_REQUIRED，真实网络校验 NOT RUN |
| 09 | L0，部分退款/错币/错地址/未 final | 部分退款引用；退款匹配辅助函数反例 | 不能展示全额退款 | PASS；REVIEW_REQUIRED，负例均 false；实际退款查询/全额退款执行 NOT RUN |
| 10 | L0，PRIVATE_MARKER_92、篡改密文 | 翻转 AES 密文字节；扫描 DB；读取公共静态页 | 解密失败；无敏感明文 | PASS；GCM 拒绝、DB marker 不存在、静态 HTML 不含私密账单；未做全面渗透测试 |
| 11 | L0，字段集、指定版本、接收人、到期/撤权 | 旧版本授权后编辑；其他人读；到期；撤销后读/导出 | 版本冻结、字段隔离、新访问 403 | PASS；域测试 + 浏览器实际导出和撤权下载 403 |
| 12 | L0/L1/L2 模式配置与 mock/testUSD 反例 | 真实模式请求、适配器每种能力、错误资产创建 | 禁用通道不回退；模拟不能核销真实 | PASS；503 / schema 拒绝；所有真实交易 NOT RUN |

额外测试覆盖：零/负数/小数/科学计数/超范围/JS Number 金额拒绝；超安全整数金额保持精确；主动内容 MIME 拒绝；同源保护；no-store/CSP/HttpOnly 属性；严格输入阻止客户端 success 注入。

## 浏览器证据

- `tests/browser/flow.spec.ts` 第一个用例：四个页面、刷新确认状态、模拟结算、收款确认、选字段授权、会计导出、撤权、移动布局。
- 第二个用例：编辑金额使旧批准失效，再审批付款，模拟超时，刷新仍 UNKNOWN 且不允许创建新尝试。
- [桌面付款页](evidence/payment-desktop.png) 与 [移动授权页](evidence/disclosure-mobile.png) 只含假数据。

## 验收边界

交付名只能写“L0 模拟 MVP”。本报告不是 L1/L2 实际付款成功证据，不是生产安全认证，不保证比赛资格。PostgreSQL 路径现已完成关系约束、SQL revision CAS 和并发/恢复测试；生产多节点压力与灾备、真实登录、钱包签名、RPC 网络/资产核验、精确输出交易条件和完整退款仍有明确缺口，详见 ARCHITECTURE.md、INTEGRATION.md 和 TASKS.md。

## 交付复核追加

对抗性独立审查发现并修复 1 原子单位少付误结清、畸形离线 receipt 抛异常；另加强未知执行引用 UNKNOWN、worker 异常隔离。新增 HTTP 权限/CSRF/条件下载矩阵、同键跨单据、事件复用回滚和 6 进程竞争回归。详见 [REVIEW.md](REVIEW.md)。

最终范围仍是 L0 模拟原型，23 项通用服务端测试 + 2 项 SQLite E2E，以及 10 个 PostgreSQL 子场景（Node 计数 11）+ 2 项 PostgreSQL E2E 均通过；不是完整生产 MVP。源码 ZIP 只含文本源码/配置/文档，截图不纳入 ZIP。

## 2026-10-25 PostgreSQL 与认证验证追加

- 实测引擎 PostgreSQL 18.6，官方镜像 digest 固定；无云端账户，本地 loopback 临时容器。测试后已停止容器。
- `npm run test:postgres` 10 个子场景（含父测试 Node 报 11/11），覆盖迁移重复执行、外键/唯一/部分索引/不可变触发器、六进程竞争、事务回滚、过期报价、旧审批、迟到状态 CAS、连接池重建恢复、事件复用、字段授权、错密钥/AAD 调包和元数据不一致。
- `npm run test:e2e:postgres` 2/2 通过，独立 schema，实际 PostgreSQL。SQLite `npm run test:e2e` 单独 2/2 通过，不混记。
- `bash scripts/postgres-local.sh start` → `npm run db:migrate` 两次 → stop 已实测，可重复迁移且清理容器。
- `npm test` 增加域名/账户/nonce/用途/时效/签名验证回归，共 23/23 通过。内存测试密钥没有注册或用于钱包；没有真实会话或交易。
- 独立审查发现并修复：PostgreSQL invoice 明文状态列与密文未比对、审计 AAD 未绑定单条 ID、纯登录验证对 loopback 未限制协议；有负例回归。
- `npm run lint`、`npm run typecheck`、`npm run build` 通过；运行依赖审计 0 vulnerabilities。不是生产安全证明。
- Library 支持流程有界重试一次，仍在工具发现 tools/list 阶段返回 network。未上传、无 library_file_id；本地 ZIP/报告保留，不能称已交付原生附件。

架构和复现见 [POSTGRES.md](POSTGRES.md)，真实认证/钱包/L1 最小输入见 [AUTH_L1_INPUTS.md](AUTH_L1_INPUTS.md)。

## 2026-10-25 NEP-413 认证基础最终追加（当前结果）

| 检查 | 当前结果 | 证据边界 |
| --- | --- | --- |
| lint/typecheck/build | PASS | 编译与静态检查，不代表生产认证审计 |
| 通用测试 | PASS 28/28 | NEP-413公开示例字节、签名反例、固定RPC网络、严格直接receipt、原L0安全回归；全部fixture/mock |
| PostgreSQL | PASS 20/20（18子场景+2父） | 含8个新增认证子场景：nonce六并发仅一会话、重放、错域名/链/权限、过期、撤销、插入回滚、并发轮换及退出竞态、HTTP角色隔离 |
| SQLite浏览器 | PASS 3/3 | 两个L0闭环；一个mock认证模式显示测试 |
| PostgreSQL浏览器 | PASS 3/3 | 两个真实PG支持的L0闭环；一个mock认证模式显示测试 |
| 真实NEAR RPC/账户/钱包 | NOT RUN | 没有访问真实账户RPC、连接钱包或绑定真实账户 |
| L1付款、L2结算退款 | NOT RUN / BLOCKED | 支付硬禁用；不以fixture匹配替代真实证据 |
| Library上传 | NOT RUN（本轮） | 遵守不重试要求，原交付阻塞未解除，无library_file_id |

独立审查复现并修复：constructor原型账户绕过配置检查、宽松action字段/非规范Base64/悬空receipt引用；分别有拒绝断言。另新增并发rotate仅一赢家、阻塞RPC期间logout后resolve失败的定向测试。

一轮新增浏览器检查曾发现CSS的label display规则覆盖hidden属性，导致NEP413模式仍显示演示选择器（服务端仍拒绝demo）。已统一hidden样式并通过3/3重跑，没有保留失败项。

认证默认关闭，示例配置含不可用占位符；当前无钱包客户端接入，也未部署身份提供商。详见 NEAR_AUTH.md 与更新后的 AUTH_L1_INPUTS.md。前文23/11/2等计数为上一轮历史，当前以本表为准。

## 2026-10-25 钱包客户端、L1 待签与 CI 最终验收（覆盖前文计数）

最终执行：`TEST_DATABASE_URL=postgresql://postgres:local-fake-data-only@127.0.0.1:55432/privacy_payments bash scripts/ci.sh`，退出码 0。日志保留在执行环境 `/tmp/privacy-payments-final-checks.log`，不作为源码打包。

| 项目 | 结果 | 实际证据与限制 |
| --- | --- | --- |
| lint / typecheck / build | PASS | 包括官方 SDK 同源构建；锁定 npm 依赖 |
| 通用服务端测试 | PASS 28/28 | 原 L0 安全/权限/状态机及 NEP-413/RPC 反例 |
| PostgreSQL 集成 | PASS 35/35（含父测试计数） | 本地 PostgreSQL 18.6；认证8、原持久化10、L1服务11子场景，另有L1 HTTP和实际浏览器L0/L1两项完整测试 |
| SQLite 启动的浏览器套件 | PASS 10/10 | 原L0流程3、L1 transport fixture3、官方SDK钱包fixture4；不把route mock当SQLite支持L1 |
| PostgreSQL 启动的浏览器套件 | PASS 10/10 | 原L0实际PG流程，其余独立mock界面测试；真实L1服务端浏览器在上方PG集成单独覆盖 |
| 运行依赖审计 | PASS | npm audit --omit=dev：0 vulnerabilities；不代表完整供应链审计 |
| 独立安全审查 | PASS（已修复发现项） | 过期请求必须核验实际区块时间；SDK父窗口伪造传输被类实例检查阻断；均有负例 |
| GitHub Actions | NOT RUN | 已准备最小权限、固定官方Actions SHA的workflow，按要求只本地提交，未推送 |
| 真实钱包、账户或RPC | NOT RUN | 测试签名为内存fixture；未连接或绑定真实账户 |
| 真实L1付款 | NOT RUN / 配置待核实 | 无经验证testUSD合约、精度、公开账户或实际交易授权；默认关闭 |
| L2保密结算 | BLOCKED | 无Intents测试网，历史invite-only和partner能力/完整到账退款证据缺失 |
| 部署、生产恢复、Library | NOT RUN | 未部署/开户/执行交易；只准备备份恢复说明；没有重试Library上传，无library_file_id |

### 新测试的实际断言

- `tests/postgres/wallet-browser.test.ts`：真实 Chromium 加载同源官方 SDK，用受控 injected 钱包签署真实服务端挑战；实际 Express 验签、PostgreSQL nonce消费、会话持久化、刷新和退出。L1场景实际经过UI创建→审批→前置检查→确认→待签→人工填fixture hash→RPC fixture核验→刷新；L0 API403，退出后会话401。只mock钱包和链RPC，不mock应用HTTP。
- `tests/postgres/l1-http.test.ts`：真实认证会话、CSRF、viewer/recipient越权写拒绝、公开config不泄漏账户、同键异参409、模拟reference和客户端success字段拒绝、收款确认、no-store及L0隔离。
- `tests/postgres/l1.test.ts`：六并发幂等、重复prepare保持同一请求、重复submit保持相同引用、storage/metadata/余额失败、跨RPC过期、UNKNOWN恢复、随机memo防旧交易、事件复用拒绝、迟到区块时间、并发核验CAS以及SQL故障回滚。
- `tests/browser/wallet.spec.ts`：官方SDK的成功、拒签、错账户、伪造父窗口消息；断言不请求addFunctionCallKey，不调用交易发送，无持久localStorage。

初始开发检查曾因新增区块时间fixture时钟不同步和浏览器序列化测试函数失败，已修复测试夹具并完整重跑；最终没有失败或跳过项。独立审查发现的两项真实实现问题也已修复，不能把早期失败计为未处理。

已人工查看 `/tmp/privacy-payments-l1.png` 的实际浏览器fixture页面，准确显示testUSD无美元价值、配置、审批、待签请求及证据；截图仅假数据，不纳入文本源码包。

交付仍称 **L0可运行原型 + L1配置式待签/核验代码（fixture验收）**。L1目前不可编辑v1、不支持会计逐单披露、自动storage注册或退款，gas limit不是网络费用价格上限；不是完整生产MVP，不是实际L1或L2付款验收。最终测试适用本轮本地提交的代码；随后仅更新验收文本和打包。
