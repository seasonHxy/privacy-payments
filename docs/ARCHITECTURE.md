# 架构与内部契约

更新：2026-10-25 新增独立 PostgreSQL 关系存储路径，支持 SQL 唯一约束、行锁和 revision CAS，已实际运行。详见 [POSTGRES.md](POSTGRES.md)。下述聚合状态设计与缺少关系索引的说明只针对保留的 SQLite 路径，不能用于描述 PostgreSQL 路径。

## 保留的 SQLite 演示路径

Node 24 LTS + Express 5 + TypeScript，独立静态前端，SQLite WAL。单个加密聚合状态包含 Invoice、InvoiceVersion、Approval、PaymentAttempt、QuoteSnapshot、SettlementEvidence、DisclosureGrant、AuditEvent。预置 Membership 表达工作区/角色，只有 demo 工作区出现在 UI。此 SQLite 路径不使用 PostgreSQL；新增 PostgreSQL 路径见 POSTGRES.md。两者都没有数据库 RLS，权限在服务端验证。

`Store` 初始化 schema v1：`state(id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL)`。每次服务调用在 `BEGIN IMMEDIATE` 中读取、解密、校验、修改、重新认证加密并提交；异常回滚。SQLite 文件级写锁跨连接串行化，busy_timeout=5 秒。所有版本唯一、工作区幂等键唯一、每账单唯一活动尝试和证据不可复用检查在同一锁内完成。没有另一个可绕过此事务的应用写入路径。

**SQLite 路径与完整规格的差异：** 唯一约束由事务内应用不变量维护，不是各实体独立 SQL 唯一索引；没有 PostgreSQL 行锁或多节点扩展性。所有读也会重新加密整个状态，因此只适合小规模假数据演示。PostgreSQL 路径已拆分关系表、添加唯一/部分索引、迁移版本并完成限定并发测试。生产压力测试、密钥轮换与灾备恢复仍未完成。

## 不变量

- 输入 schema 严格拒绝未知字段；版本数组只追加。新版本需 expectedVersion；旧审批失效、签名前的尝试标记 FAILED_NO_TRANSFER，不能继续报价确认。
- AWAITING_SIGNATURE 及后续状态锁定账单。报价过期不能准备或提交；可在尚未提交时拒签后创建新尝试。
- 正整数字符串上限 78 位；BigInt 计算。费用为模拟固定 100 原子单位；输入含费用须仍在 78 位范围。decimals=6 是本地模拟配置，不暗示真实资产精度。
- 规范化 JSON 对键排序后 SHA-256，仅用于应用内绑定，绝不发送上链。确认绑定账单版本、模式、资产、网络、收款/退款目的地、输入、输出、费用、期限、退款条件。
- `workspace + idempotencyKey` 同参数复用，同键异参数 409。活动尝试存在则不同键也无法付款。UNKNOWN、REVIEW_REQUIRED、REFUNDED 都不自动释放新付款能力。
- 状态 revision 单调递增。领域核验逻辑同步运行于存储事务内；重放只会在可核验状态进行。PostgreSQL 路径现已实现 expectedRevision 校验及 SQL 条件更新 CAS，SQLite 路径仍依靠同步写事务。真实网络 worker/持久队列尚未实现。
- SUBMITTED 只记录标识。模拟 verifier 才能设置 VERIFIED_SUCCESS；客户端不能提供任意证据。收款方确认单独记录。
- 全额退款匹配辅助函数校验资产、网络、目的地、金额和最终性；没有调用方能把模拟部分退款设置为 REFUNDED。退款 API 尚未实现。
- L1/L2 DisabledAdapter 五种能力均抛明确不可用错误，没有回退。

## API

所有写请求需同源 Origin 和 JSON Content-Type；所有私密对象需会话、工作区和对象权限。错误只返回错误码，不回显正文。状态码使用 401/403/404/409/400/503。下载重复鉴权、no-store、nosniff、attachment。常驻 CSP 禁止外部资源与内联脚本。

| 方法/路径 | 输入/行为 |
| --- | --- |
| POST /api/demo/session | `{user}`，仅 L0 预置身份，轮换 HttpOnly cookie |
| GET /api/me | 角色、工作区、固定资产、禁用等级 |
| GET/POST /api/invoices | 列表 / 严格 Payload 创建 |
| GET /api/invoices/:id | payer 或关联 recipient 的完整版本记录 |
| PATCH /api/invoices/:id | `{expectedVersion,payload}` |
| GET /api/invoices/:id/attachment?version=N | 授权文本下载 |
| POST /api/invoices/:id/approvals | `{version}`，payer |
| POST /api/invoices/:id/payment-attempts | `{version,mode?}` + Idempotency-Key |
| POST /api/payment-attempts/:id/quote | 生成服务端模拟报价 |
| POST /api/payment-attempts/:id/confirm | `{version,quoteFingerprint}` |
| POST /api/payment-attempts/:id/prepare-signing | 返回 SIMULATION_ONLY，walletRequest=null |
| POST /api/payment-attempts/:id/execution-reference | `{reference}`；仅 sim:success/timeout/underpaid/failed/refund-partial |
| POST /api/payment-attempts/:id/reject | 提交前模拟拒签 |
| GET /api/payment-attempts/:id | 当前状态，revision，原因和证据 |
| POST /api/payment-attempts/:id/recheck | 只读执行核验，不签名不付款 |
| POST /api/invoices/:id/acknowledgement | 仅关联收款人确认模拟证据 |
| GET/POST /api/disclosures | 收件人/付款人可见授权列表；创建授权需 payer |
| GET /api/disclosures/:id | 只有明确接收人可读指定版本和字段 |
| GET /api/disclosures/:id/export | 同样鉴权的 JSON 下载 |
| DELETE /api/disclosures/:id | payer 撤权并审计 |

Payload: `{amountAtomic, asset:'mock:USD', network:'mock-local', recipient:'recipient', address:'demo:…', purpose, attachment?:{name,type:'text/plain',content}}`。附件名限制字符，内容 UTF-8 最大 65536 bytes。浏览器仅支持 .txt。

Grant: `{invoiceId,version,recipient:'accountant',fields,expiresAt}`。字段白名单 amountAtomic/asset/network/purpose/address/evidence；期限最多 30 天。证据字段是 source/final/success/receivedAcknowledged 摘要，不绕过地址和金额字段授权。接口自身的账单 ID、版本、L0 模式和模拟提示始终返回。
