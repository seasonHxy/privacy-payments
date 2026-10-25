# PostgreSQL L0 持久化与实测

本轮在本地官方 Docker 镜像运行 **PostgreSQL 18.6**，不是 SQLite 模拟。镜像锁定为 `postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6`。仅绑定 `127.0.0.1:55432`，使用公开、可丢弃的本地假数据密码；没有创建云端数据库账户或外部持久凭据。

## 复现本地 PostgreSQL

```sh
npm ci --cache /tmp/npm-cache
bash scripts/postgres-local.sh start
export DATABASE_URL='postgresql://postgres:local-fake-data-only@127.0.0.1:55432/privacy_payments'
export TEST_DATABASE_URL="$DATABASE_URL"
export DATA_DIR=./data/postgres-demo
npm run db:migrate
npm run build
STORAGE_DRIVER=postgres npm start
```

访问 `http://127.0.0.1:3000`，同样执行 L0 四页流程。`npm run db:migrate` 只应用本地 schema/预置演示成员，不启动 HTTP。PostgreSQL 模式启动也会验证/应用迁移；密钥使用同一个 DATA_DIR 下的 storage.key。应用入口拒绝非 localhost/loopback 数据库地址。未使用钱包或真实资金。

测试在另一个终端运行：

```sh
export TEST_DATABASE_URL='postgresql://postgres:local-fake-data-only@127.0.0.1:55432/privacy_payments'
npm run test:postgres
npm run test:e2e:postgres
```

两个命令分别创建随机测试 schema，并在结束后删除；不会清空 public 演示数据。缺少 TEST_DATABASE_URL 时明确失败，不跳过后声称通过。浏览器测试独立 schema、独立密钥目录，使用系统 Chromium。

测试完执行 `bash scripts/postgres-local.sh stop`。容器为 --rm，无持久挂载；停止即丢弃其演示数据库。保留在工作区的存储密钥不包含钱包能力，数据库丢弃后也不能恢复数据。本轮临时容器名称为 privacy-payments-pg-review，已在交付前停止；复现脚本使用 privacy-payments-postgres。

## 迁移与关系

`migrations/001_relational.sql` 创建 workspace、membership、invoice、invoice_version、approval、payment_attempt、quote_snapshot、settlement_evidence、disclosure_grant、audit_event；另有 schema_migrations 记录版本和 SHA-256。迁移使用同一 pg client 的 BEGIN/COMMIT/ROLLBACK，以及事务级 advisory lock，重复执行检查 checksum，发现历史脚本变化则失败。

数据库约束：

- Membership `(workspace_id,user_id)` 联合主键；version `(invoice_id,version)` 主键；当前版本必须存在（延迟外键）。
- 对象间使用包含 workspace 的复合外键，避免账单、审批、支付尝试、披露关联到其他工作区。
- 工作区幂等 HMAC tag 唯一；同账单最多一个非 USER_REJECTED/FAILED_NO_TRANSFER 的尝试（部分唯一索引）。
- 审批引用精确绑定账单版本；每版本一个 active approval。新尝试触发器锁账单并拒绝已结清、旧版本或失效审批。
- 结算 event HMAC tag 全局唯一；每 attempt 一个 evidence。报价保存为不可变历史 snapshot。
- 账单版本与报价禁止 UPDATE/DELETE 的触发器；新版本只追加。

没有把原 SQLite 文件自动转换成 PostgreSQL。两种后端独立；现有演示数据应留在原 SQLite 路径。生产数据导入、在线升级、版本降级及灾备恢复演练未实现。SQL 事务回滚测试不能替代生产数据迁移验收。

## 事务与 CAS

PostgresRepository 使用真实 `pg.Pool` 获取一个 client，事务中验证工作区成员、对 workspace 行 `FOR UPDATE`，再锁该工作区 invoice 行。解密该工作区实体、在独立内存事务运行共用领域规则、按差异保存关系行。**该路径没有使用 SQLite，内存模型只是事务内业务规则载体。**

付款状态 UPDATE 使用 `WHERE id=… AND workspace_id=… AND revision=expected`，检查 rowCount=1。核验入口也接受执行快照 expectedRevision；迟到 worker 不能覆盖新状态。提交后的回调传入 SUBMITTED revision；重启恢复从 PostgreSQL 读取待核验尝试及其 revision。错过版本时抛 STALE_VERIFICATION，不能把超时自动当失败重付。

这是面向单工作区小团队的保守串行化方案：同工作区的读取和写入均持工作区锁，会加载整个工作区。不同工作区可并行，但大数据量/吞吐不适用。没有独立队列、后台网络重试、跨区域部署或生产压测。连接用 postgres 演示管理员只是本地测试便利，不是生产最小权限角色。

## 加密与泄漏面

金额、地址、附件、账单正文、报价条件、原始证据仍为 AES-256-GCM 密文；AAD 绑定表、工作区与实体 ID（版本和报价还绑定版本/修订号，审计绑定单条 ID）。密文认证失败不返回正文。

明文索引刻意暴露工作区/成员与角色、对象关联、版本、审批 active、支付状态、revision、结清位及行数；没有金额、地址或用途明文索引。幂等键和结算事件用带域分离的 HMAC tag 索引，原值留在密文。账单明文 current/settled 与密文 header 一致性校验；支付明文 state/revision 同样核对。审计 ID 的 AAD 可拒绝调包，不提供防整库回滚、删除或数据库超级用户攻击的不可抵赖账本。

密钥轮换需要重新加密及重建 HMAC 索引，尚未实现。服务端可以解密，仍不是端到端加密。

## 实测断言

`tests/postgres/integration.test.ts`：10 个子场景（Node 统计含父测试共 11）包括迁移与版本、同键复用/异账单冲突、数据库唯一/不可变约束、6 个独立 Node 进程竞争、过期报价及旧审批、注入 audit SQL 失败后的三表回滚、双 worker CAS、关闭连接池后恢复、结算事件唯一与披露撤权、跨工作区外键/错密钥/AAD 调包/元数据篡改，以及异步 HTTP 读取。

`npm run test:e2e:postgres`：实际 PostgreSQL 后端运行完整授权/收款确认/导出撤权和改版/UNKNOWN 刷新两个浏览器流程。SQLite 的 E2E 单独运行并单独报告。

官方依据：[PostgreSQL 行锁](https://www.postgresql.org/docs/current/explicit-locking.html)、[数据库约束](https://www.postgresql.org/docs/current/ddl-constraints.html)、[node-postgres 同连接事务](https://node-postgres.com/features/transactions)。

## 认证迁移追加

002_auth.sql 新增 auth_challenges/auth_sessions，版本1未改动，迁移器逐版本检查checksum。挑战nonce消费与会话签发同事务，并支持撤销/轮换；新增8个真实PostgreSQL认证子场景，但RPC全部mock，见 NEAR_AUTH.md。全套PostgreSQL现为18子场景（含父测试计数20），另有3个PG浏览器用例（第三个mock模式显示，不代表钱包登录）。

## 本轮 L1 独立命名空间

migration003 增加 l1_invoices 与 l1_events；总计三份迁移、15张表（含 schema_migrations）。L1 金额、审批、报价、请求、执行引用、原始证据和审计时间线均在认证加密 payload 内，数据库暴露 UUID、revision、HMAC 幂等及事件相等关系。L0 行不会被 L1 读取或结清。L1 是单付款人/单收款人配置下的独立不可变 v1 工作流，尚无版本编辑和会计披露迁移；不可把这项简化当作完整多租户模式。最终测试数量见 ACCEPTANCE.md。

## 本轮版本与披露迁移004

共4份迁移、17张表（包含schema_migrations）。新增l1_invoice_versions以(invoice_id,version)联合主键、SQL不可变触发器保护版本密文；l1_disclosures以联合外键绑定具体版本，接收人索引为HMAC。授权期限/撤权时间列与密文逐项比对。旧v1加密单据安全补录到版本表，不另建L1账单；新版本缺失直接拒绝。编辑、授权和撤权均在既有invoice行锁与revision CAS事务中完成，失败全部回滚。

最终PG计数45=4父测试+41实际子/独立测试：认证8、既有持久化10、L1付款流程11、版本/披露9、HTTP1、真实浏览器L0/L1各1。全部使用实际PostgreSQL 18.6；NEAR钱包和RPC均fixture。SQLite启动的Playwright套件不承载真实认证服务端测试，不能把其套件名称当作这些认证测试的数据库类型。
