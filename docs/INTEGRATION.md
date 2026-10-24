# T0 接入证据清单

只读核实：2026-10-24 UTC。没有创建账户、获取权限、请求执行报价、生成钱包密钥、签名或广播。公开文档不是实际权限或结算成功证明。

## 决策

- L0：PASS（内部模拟能力可实现，闭环测试另见验收报告）。
- L1：PARTIAL / 执行禁用。已核实 NEAR RPC 与 NEP-141 文档形态，完成离线 final receipt/event 检查辅助函数；允许 testUSD 的发行合约、精度、钱包、测试账户、可信 RPC 网络归属尚未核实，没有真实付款授权。
- L2：BLOCKED。无法证明完整授权查询、可靠收款核验与退款闭环；不能凭通道 SUCCEEDED 字符串通过验收。

## 官方事实与实施影响

| 项目 | 只读证据 | 状态与影响 |
| --- | --- | --- |
| 环境 | [Quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction) 明确没有 Intents 测试网 | 已证实；不能把 testUSD 冒充保密测试资产 |
| 资产与精度 | [Making a Request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request) 提供 GET /v0/tokens 和 decimals/assetId 结构 | 接口文档已证实；本产品具体资产/合约未选定、未验证，不硬编码猜测 |
| 报价及费用 | 同上列出 quote、deadline、输入资产、退款目的地；未认证额外费用有文档说明 | 通道级结构已知；本产品精确输出、全部费用上限和实际报价期限仍未验证 |
| 保密路径 | [Confidential Swaps](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps) 描述 confidentiality 与嵌入式余额两种集成 | 路径存在不等于本项目已接入。未请求真实报价 |
| 签名与认证 | [Signed Intent Execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution) 区分外部链存款和余额意图签名；后者需 partner authentication | 文档存在；本项目没有 partner 凭证或签名验证流程，禁用 |
| 完整历史 | [Get transaction history](https://docs.near-intents.org/api-reference/account/get-transaction-history) 标明 invite-only | 关键权限缺失，不能绕过或伪造历史 |
| 收款与退款 | 报价/状态接口不自动提供本产品所需“授权版本→报价→实际到账→可信最终退款”的完整证据 | 本产品端到端证据未获验证，BLOCKED |
| NEAR 最终性 | [Transactions](https://docs.near.org/api/rpc/transactions) 的 FINAL 等待所有 receipts 最终确认 | 辅助函数拒绝 optimistic 或只有 hash 的输入 |
| 代币事件 | [NEP-141 官方规范](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) | 检查可信合约 executor、成功 receipt 与单个精确 ft_transfer 事件；fixture 不证明真实网络 |
| 隐私条款 | [near.com privacy](https://near.com/privacy) 适用特定界面，不是全部协议的不可见保证 | 不宣称完全匿名或服务商不可见 |
| 运行时 | [Node release status](https://nodejs.org/en/about/previous-releases) 列出 Node 24 为 LTS | 本环境 v24.19.0；依赖从标准 npm registry 安装并锁定 |

## T4 已做与尚未做

`inspectNearReceipt` 检查 FINAL、交易 hash/signer/receiver、成功结果、指定合约 receipt executor、NEP-141 事件版本、付款/收款/整数金额及冲突事件。任何匹配仅返回 `OFFLINE_MATCH_ONLY`，永不返回真实 VERIFIED_SUCCESS。

尚未实现 RPC 拉取/网络 genesis 校验/可信资产元数据确认/余额与收款独立核对/钱包请求构造/真实退款查询/真实 L1 状态集成。当前不接受上传外部 receipt 来结清账单。fixture 合约名明确为 `fixture.testnet`，不代表部署地址。

## 下一阶段开关条件

L1：用户明确批准测试条件，验证 testUSD 合约和 decimals、网络与付款/收款账户，完成真实登录与钱包挑战、请求白名单、真实适配器与异步 CAS、可信 RPC 核验及收款证据后，才能考虑启用。测试币无美元价值，地址金额公开。

L2：逐项确认允许资产、精确输出条件、所有费用、报价有效期、签名格式、查询权限、可信结算凭据、收款核对及退款证据；完成隐私矩阵和授权的真实交易验收。不能仅修改 PAYMENT_MODE 即开启。

比赛规则页面浏览工具此次因 text/markdown 内容类型未读取成功；未据此做资格结论。赛前开发如实记录，最终规则、资格及提交信息另行确认。
