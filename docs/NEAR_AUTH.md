# NEP-413 认证基础与只读 RPC

2026-10-25。已实现并用公开协议示例、内存签名 fixture、mock RPC 与真实 PostgreSQL 测试。**没有使用真实账户、钱包或外部凭据，没有调用真实账户 RPC；真实登录默认关闭，所有支付仍为 L0。**

## 官方依据

- [NEP-413 Final](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)：本实现使用协议标签、Borsh 字段布局、32 字节 nonce、callback Option，对编码后的 SHA-256 验证 Ed25519 签名。测试固定了规范中的 hi/myapp.com 示例字节。
- [Access key 查询](https://docs.near.org/api/rpc/contracts)：使用 `query`、`request_type=view_access_key`、`finality=final`。只接受当前 `FullAccess`，不创建或授予访问密钥。
- [Status](https://docs.near.org/api-reference/post-status)：要求配置的 chain_id 与 genesis_hash 匹配，且节点不处于 syncing。
- [交易查询](https://docs.near.org/api/rpc/transactions) 与 [tx_status 结构](https://docs.near.org/api-reference/post-tx_status)：只读获取指定交易，要求 FINAL；不把 optimistic 或单独 hash 当成功。
- [nearcore views](https://github.com/near/nearcore/blob/master/core/primitives/src/views.rs)：根据 receipt_ids 建立生成关系；executor_id 对交易代表 signer，对 receipt 代表执行接收账户。只检查关联直接合约 receipt 的事件。

`src/login-proof.ts` 保留为上一轮自定义离线实验，**不用于新登录路径，不称为 NEP-413**。真实协议实现独立位于 `src/nep413.ts`。

## 默认与启用条件

默认 `AUTH_MODE=demo`，`/api/auth/challenge`、verify、rotate 返回 REAL_AUTH_DISABLED，原有 L0 演示仍可运行。默认不加载 RPC 或账户配置。

`AUTH_MODE=near` 必须同时使用 PostgreSQL，提供 `NEAR_AUTH_CONFIG` 文件及与其 origin 完全相同的 `APP_ORIGIN`。配置必须包括 HTTPS origin（本地开发允许 HTTP loopback）、固定 HTTPS RPC URL、chainId=testnet、经核实的 genesisHash、现有公开账户到应用成员的明确映射。禁止 RPC 重定向和 URL 内用户名/密码。缺字段、错误链或无成员映射都拒绝启动。

`config/near-auth.example.json` 故意包含无法通过校验的占位符，**不能直接启用**。真实本地配置命名 `config/*.local.json` 已忽略，不应提交实际人员映射。配置式映射只决定本应用 payer/recipient/accountant/admin 成员槽位；它不创建、绑定链上账户或授权钱包。付款保持 L0，L1/L2 硬禁用。

启用 near 模式后：demo 登录接口拒绝，旧 demo cookie 不被识别；浏览器隐藏身份切换，未登录时显示钱包界面尚未接入，绝不降级登录为 payer。没有自动建立身份提供商或钱包 SDK。当前提供服务端 API 基础，不宣称已跑通真实钱包 UI。

## API 和持久化

所有 POST 均要求精确 Origin 和 JSON。认证响应 no-store；cookie 为 HttpOnly、SameSite=Strict，HTTPS origin 下增加 Secure。

| 接口 | 行为 |
| --- | --- |
| GET /api/auth/config | 仅返回 DEMO/NEP413 和 L0 模式，不公布成员映射 |
| POST /api/auth/challenge | 输入 `{accountId}`，必须是配置自有属性中的已授权账户；生成 5 分钟挑战，返回 message、nonceBase64、recipient、state、challengeId；设置浏览器状态 cookie |
| POST /api/auth/verify | 输入 challengeId/accountId/publicKey/signature/state；公钥只是候选，服务端验签后从固定 RPC 查验该账户当前 FullAccess；不接受客户端 role 或 authorizedPublicKey |
| POST /api/auth/rotate | 新随机会话令牌替换旧令牌，旧令牌立即撤销；并发轮换只有一个成功 |
| POST /api/auth/logout | 撤销当前会话，清除认证与挑战 cookie；demo 模式也可退出 |

签名请求的 message 绑定 login 用途、origin、testnet、genesisHash、账户、挑战 ID、签发及到期时间；NEP-413 外层再绑定 recipient 和 nonce。签名不是支付授权。nonceBase64 在钱包客户端调用 signMessage 前须解码为 32 字节。当前没有 web-wallet callback 跳转桥接；服务端登录只接受没有 callbackUrl 的签名请求，协议纯模块另覆盖可选 callback 编码测试。

迁移 `002_auth.sql` 新增 auth_challenges 和 auth_sessions。nonce 与会话令牌仅存 HMAC tag 索引，业务内容 AES-GCM 加密，AAD 绑定挑战 ID 或会话 tag。挑战与会话到期/撤销时间作为索引元数据可见。挑战消费采用 `SELECT FOR UPDATE` 加条件 UPDATE，并与新会话插入同一事务；插入失败会回滚消费。

会话有效期 15 分钟，轮换重新计时；配置指纹变化会使旧挑战/会话无效。每次请求重新查询 FullAccess，不缓存密钥有效性；RPC 返回后再次检查会话撤销/到期，避免退出期间的慢请求恢复身份。网络证据不可得时拒绝访问，不回退到 demo。会话认证基于查询时的最终块，不能保证该块之后链上密钥永不变化。

仍需生产工作：限流/滥用防护、过期记录清理、绝对会话寿命策略、真正钱包客户端互通、运维与安全审计。事务持锁期间有有界 RPC 等待，吞吐有限；RPC 服务方可见查询的账户/公钥。数据库超级用户、主机和解密密钥均属于信任边界。

## 只读 receipt 适配器

`NearReadOnlyRpc` 只具备 status、view_access_key 和 tx_status；没有签名、广播或交易方法。端点来自服务端配置，HTTPS、禁止重定向、4 秒请求超时、2 MB 响应上限、JSON-RPC ID 匹配。

`fetchAndInspectTransfer` 只支持直接单次 `ft_transfer`：固定交易 hash/付款人/代币合约，准确 receiver/整数金额/1 yocto deposit、规范 Base64 参数；必须 FINAL，所有所需 outcomes 成功且 receipt 图完整无重复/无悬空。只取直接合约 root receipt 的单个 NEP-141 transfer 事件，不使用嵌套日志、无关 receipt 或余额差额。ft_transfer_call、复杂图和不明确证据保守拒绝。

匹配仅返回 READ_ONLY_MATCH；网络证据缺失返回 UNKNOWN，形态不符合返回 REVIEW_REQUIRED。这些结果没有接入账单结清，**不代表 L1 已执行，也不证明代币是被允许的 testUSD**。信任的是固定 RPC 的断言，不是轻客户端密码学证明。资产合约/元数据/代码信任、钱包执行、收款人独立核对和实际交易仍未验收。

## 可复现验证

```sh
npm ci --cache /tmp/npm-cache
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
bash scripts/postgres-local.sh start
export TEST_DATABASE_URL='postgresql://postgres:local-fake-data-only@127.0.0.1:55432/privacy_payments'
npm run test:postgres
npm run test:e2e:postgres
bash scripts/postgres-local.sh stop
```

测试只用临时 PostgreSQL schema 和内存 Ed25519 fixture，没有真实账户操作。28 项通用测试、PostgreSQL 18 个子场景（含两个父测试计数20），SQLite/PG 各3个浏览器用例通过。浏览器第三个用例 mock 认证配置，确认缺失会话时不回退 demo；真实 NEP-413 会话由 PostgreSQL+HTTP mock 测试覆盖，并非真实钱包浏览器测试。

## 本轮客户端补充

现已有官方 NEAR Connect SDK 的受限注入式钱包客户端，walletId 可选配置，无配置则显示待配置。仅实例类型经过检查的 InjectedWallet，空远端 manifest、无持久钱包选择、不添加访问密钥、不调用交易发送。真实浏览器到 PostgreSQL 会话测试已通过，钱包/RPC 仍 mock，见 WALLET.md。L1 可在独立配置下生成请求与只读核验，默认关闭；不能把此能力称真实付款已验收。
