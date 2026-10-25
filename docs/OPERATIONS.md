# 本地检查、部署准备与恢复边界

本文件提供可复现检查及未来人工运维步骤；不代表已经部署、开启 GitHub Actions 或完成生产灾备验收。真实链上交易不属于 CI。所有测试仅用假数据、临时数据库和受控钱包/RPC fixture。

## 完整本地检查

需要 Node 24、Docker 和 Chromium。先安装锁定依赖；已有系统 Chromium 可沿用默认 `/usr/bin/chromium`，或按官方 Playwright 安装当前锁定版本的浏览器。

```bash
npm ci
# 系统没有 Chromium 时运行；只从 Playwright 官方分发渠道安装。
./node_modules/.bin/playwright install --with-deps chromium
export CHROMIUM_PATH="$(node --input-type=module -e 'import { chromium } from "@playwright/test"; console.log(chromium.executablePath())')"
bash scripts/postgres-local.sh start
export TEST_DATABASE_URL='postgresql://postgres:local-fake-data-only@127.0.0.1:55432/privacy_payments'
bash scripts/ci.sh
bash scripts/postgres-local.sh stop
```

最后一条 stop 在检查失败后也需要人工执行。不要重复 start 或覆盖已有同名容器；确认原容器用途再处理。测试脚本要求本地 PostgreSQL URL，没有数据库就失败，不会跳过后报告全通过。它清除真实模式环境覆盖，依次执行 lint、typecheck、通用测试、build、真实 PostgreSQL 集成、SQLite 浏览器和 PostgreSQL 浏览器。测试在独立临时 schema 中运行，不能用生产数据库执行。浏览器测试可能更新仅含假数据的演示截图；检查后用 git diff 审阅。

`.github/workflows/checks.yml` 复用同一脚本，只有 contents:read 权限，不持久保存 checkout 凭据，不使用 secrets、不上传文件、不部署。使用官方 actions/checkout 与 actions/setup-node 的完整 commit SHA；2026-10-25 通过官方仓库 git ls-remote v6 核实。PostgreSQL 使用既有固定 digest 镜像。此轮只本地准备，远端 workflow 未运行，不能把本地检查写成 GitHub CI 通过。

## 部署前必须完成的工作（未执行）

- 用户确认目标环境、精确 HTTPS origin、公开账户角色和钱包方案；不向聊天或仓库提供私钥。
- 服务目前只监听 loopback；未来反向代理应终止 TLS，保持同源 API，不允许任意 Origin 或公共缓存。不要为了部署关闭同源、HttpOnly 或 CSP。
- 默认演示身份只用于假数据。真实认证、资产/网络白名单和付款权限必须按独立配置验证；缺配置保持关闭，不回退模拟成功。
- 当前 PostgreSQL 入口仅允许本机地址，演示数据库超级用户和公开测试密码不能作为生产凭据。最小权限运行角色、独立迁移角色、凭据注入和网络拓扑需要另行实现与审阅。
- 存储密钥是服务器解密能力，非钱包密钥。生产密钥管理、轮换、审计、限流、会话清理、监控脱敏、容量与故障演练尚需完成。服务器持有解密能力，不宣称端到端加密。

## 备份与恢复准备（操作手册，未作生产演练）

数据库备份与对应 `DATA_DIR/storage.key` 缺一不可。密钥不要进入源码 ZIP、Git、CI artifacts、公开链接或日志。由操作者将数据库备份和密钥分别保存在受控加密介质，记录应用 commit、迁移 checksum、备份时间和密钥版本。限制目录权限并验证备份可读取；不要以有备份文件代替恢复验收。

PostgreSQL 可用同版本官方 `pg_dump --format=custom --no-owner --no-acl` 创建一致性快照；若需要备份外部附件，还应协调同一时间点。当前附件在加密业务载荷中。下面是**仅本地假数据**示例，执行前停止应用写入，保持数据库容器运行：

```bash
umask 077
mkdir -p /tmp/privacy-payments-backup
# 不带密码到命令行，利用本地临时容器内部连接。
docker exec privacy-payments-postgres pg_dump -U postgres -d privacy_payments --format=custom --no-owner --no-acl > /tmp/privacy-payments-backup/database.dump
# 根据实际 DATA_DIR，将匹配的 storage.key 另存到受控位置；不输出密钥内容。
```

恢复必须在独立空数据库/目录中，禁止覆盖正在运行的实例。先使用 template0 创建空库，再以 `pg_restore --exit-on-error --single-transaction --no-owner --no-acl` 恢复受信备份，将匹配存储密钥放入独立 DATA_DIR 并设为 0600。切勿恢复来源不明的 SQL/备份，它们可能包含可执行数据库对象。

恢复后先撤销恢复出的会话与挑战，避免复活旧授权；认证表清理要由具备权限的操作者在隔离恢复库完成。用同一应用版本核对迁移 checksum、账单版本、审批、attempt revision、结算事件唯一与披露撤权。读取多条加密记录确认密钥匹配；用假数据检查 UNKNOWN 恢复仍不重付。恢复旧快照可能丢失其后撤权/执行记录，必须与可信证据重新对账，不能自动恢复付款能力或重复签名。

SQLite 演示恢复应停止应用后一起复制数据库及对应密钥；不要在写入时只复制主 SQLite 文件而遗漏 WAL。SQLite 与 PostgreSQL 不可直接互换，迁移导入另需工具和验收。当前临时 PostgreSQL 容器无持久卷，stop 会删除数据，不能当作备份。

## 官方依据

- [actions/checkout](https://github.com/actions/checkout) 和 [actions/setup-node](https://github.com/actions/setup-node)：官方维护的 checkout/Node 安装步骤；本项目额外固定完整 SHA。
- [Playwright CI](https://playwright.dev/docs/ci-intro)：安装项目浏览器及依赖并执行测试。
- [PostgreSQL SQL Dump](https://www.postgresql.org/docs/current/backup-dump.html)：一致性 dump、恢复至新数据库、失败终止与事务恢复。
