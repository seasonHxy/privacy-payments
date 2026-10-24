# L0 验收报告

验证日期：2026-10-24 UTC。环境 Node v24.19.0 / Linux / 系统 Chromium。全部输入均为假账单、模拟地址或离线合成 fixture。初始仓库为空；未触碰 quant-trading-agent。

## 结果分类

| 检查 | 结果 | 实际证据 |
| --- | --- | --- |
| npm run lint | PASS | ESLint src/tests，无错误；初轮未使用参数问题已修复 |
| npm run typecheck | PASS | 严格检查服务端、测试和 Playwright 配置 |
| npm test | PASS | 22 tests，22 pass，0 fail，0 skipped |
| npm run build | PASS | TypeScript 编译至 dist；npm start 启动的是构建结果 |
| npm run test:e2e | PASS | 2/2 Chromium 浏览器测试，约 4.9 秒；完整闭环、刷新恢复、修改和 UNKNOWN 锁定 |
| npm audit --omit=dev | PASS | 当次 registry 审计报告 0 vulnerabilities；不是安全审计证明 |
| 桌面/移动 UI | PASS | 1280 宽桌面、390×844 移动；移动没有横向溢出，主流程没有 pageerror；截图在 evidence/ |
| Playwright 自带浏览器安装 | BLOCKED（已替代） | CDN 返回 403 Domain forbidden；改用已安装 /usr/bin/chromium 完成测试，没有扩大权限 |
| L1 真实 testUSD 付款/核验 | NOT RUN / 禁用 | 无真实账户、钱包、资产合约/精度核实或资金操作授权；只有离线 helper 测试 |
| L2 保密付款/退款 | BLOCKED / 禁用 | 完整历史邀请权限、真实收款和退款证据、授权条件缺失 |
| PostgreSQL、生产登录、异步 worker、真实钱包 | NOT RUN / 未实现 | 不能视为生产完成 |
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

交付名只能写“L0 模拟 MVP”。本报告不是 L1/L2 实际付款成功证据，不是生产安全认证，不保证比赛资格。完整规格中的关系数据库约束、多节点异步 CAS、真实登录、钱包签名、RPC 网络/资产核验、精确输出交易条件和完整退款仍有明确缺口，详见 ARCHITECTURE.md、INTEGRATION.md 和 TASKS.md。

## 交付复核追加

对抗性独立审查发现并修复 1 原子单位少付误结清、畸形离线 receipt 抛异常；另加强未知执行引用 UNKNOWN、worker 异常隔离。新增 HTTP 权限/CSRF/条件下载矩阵、同键跨单据、事件复用回滚和 6 进程竞争回归。详见 [REVIEW.md](REVIEW.md)。

最终范围仍是 L0 模拟原型，22 项服务端测试 + 2 项 E2E 均通过；不是完整生产 MVP。源码 ZIP 只含文本源码/配置/文档，截图不纳入 ZIP。
