# Confidential Intents 只读复核

2026-10-25 UTC。本轮只读取官方文档，未请求报价、调用资金接口、申请合作方权限或账户、签署意图。L2 继续 **BLOCKED**，不会用 L1 公开付款或 L0 模拟代替。

| 能力 | 官方依据与本项目状态 |
| --- | --- |
| 环境 | [Quickstart](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction) 明确没有 Intents 测试网。不能将 testUSD 当作保密测试资产。 |
| 保密路径 | [Confidential Swaps](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps) 提供外部链存取款配合 confidentiality basic/advanced，或嵌入式 CONFIDENTIAL_INTENTS 余额路径。本项目没有验证允许资产或该账户权限。 |
| 报价 | [Making a Request](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request) 描述 GET /v0/tokens、POST /v0/quote、EXACT_OUTPUT 与 deadline。本轮未请求报价；指定资产、费用上限、精确到账和有效期均未实测。 |
| 意图授权 | [Signed Intent Execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution) 的 generate-intent / submit-intent 需要 partner authentication，推荐 X-API-Key。用户 NEP-413 登录并不获得该权限，也不是支付意图授权。没有申请凭据或调用这些端点。 |
| 完整历史 | [Get transaction history](https://docs.near-intents.org/api-reference/account/get-transaction-history) 的 GET /v0/account/history 仍注明 invite-only。本项目无邀请授权；不能绕过，不能仅靠 SUCCESS 字符串结清。 |
| 收款与退款 | 无本项目批准版本、报价、意图、收款、退款的完整可信证据；未验证收款方独立核对、部分退款与错币处理。 |

文档说明可帮助设计适配器，不构成 P0 PASS 或 L2 闭环验收。当前 P0 为 PARTIAL，L2 关键证据和权限 BLOCKED。需要用户选定资产与通道、获得合法查询权限，并另行确认具体测试条件；资金必须由用户本人执行。公共链出口、RPC/服务方访问、网络元数据及收款人再披露均是隐私边界。
