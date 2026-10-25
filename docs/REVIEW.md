# 交付对抗性复核

复核日期：2026-10-24 UTC。主实现者与独立只读审查者分别检查代码和实际测试断言。没有推送、部署、开户或执行链上交易。

## 发现与修复

| 问题 | 原始复现 | 修复与回归 |
| --- | --- | --- |
| L0 少付误结清 | 创建 amountAtomic='1'，正常审批/报价/确认，再提交 sim:underpaid；原实现固定实际到账='1'，误判 VERIFIED_SUCCESS | 按目标金额减 1 生成模拟少付，实际到账允许为 0；回归明确断言 REVIEW_REQUIRED、evidence.amountAtomic='0'、invoice.settled=false |
| 离线 receipt 畸形输入抛异常 | receipts_outcome=[null]，匹配合约的 logs=3，或 ft_transfer data=[null] | Zod 校验未知 JSON 和事件结构；回归覆盖 null/数值/字符串/不匹配结构，返回 UNKNOWN/REVIEW_REQUIRED，不抛 TypeError；该 helper 尚未接入真实 HTTP/RPC |
| 未知持久化执行引用默认进入成功分支（防御加固） | 通过测试内部状态注入 unrecognized 引用；这不是公开 API 可提交的值 | 显式识别允许的模拟引用；其他引用保持 UNKNOWN、原因 UNRECOGNIZED_EXECUTION_REFERENCE，不结清 |
| 后台 verifier 异常可逃出回调（可靠性加固） | 测试注入 verifier 异常 | 捕获异常，只记录固定无业务明文错误；保留 SUBMITTED，HTTP 仍可读；恢复 verifier 后显式重查成功 |
| 无意义 revision 自比较 | 同一同步事务内将 revision 存变量后立即比较自己 | 删除该检查；文档明确当前同步事务避免交错，但没有异步 CAS 实现 |

证据复用回归通过内部 fixture 注入重复 eventId，真正触发 EVIDENCE_ALREADY_ASSIGNED，确认整个事务回滚、第二张单据不结清且没有写入新证据。内部故障注入不代表客户端拥有数据库写权限。

追加发现：最终重跑曾发生切换身份与立即下载的浏览器竞态，返回 401 而不是预期 403，没有返回私密内容。身份切换期间现禁用身份控件，测试等待会话请求和 UI 完成，并读取 /api/me 断言新身份后再访问导出。最终以修复后检查为准，不隐去这次失败。

## 重新检查的攻击面

- 匿名、跨工作区、其他收款人、viewer/admin 不能写或读取完整对象。
- viewer 逐项请求 invoice detail、attachment、approval、payment-attempt creation/status/quote/prepare/confirm/reject/recheck/execution-reference，全部 403，响应不含业务标记。列表为空。披露仅返回指定字段。
- 空/缺失/null/恶意 Origin 不能登录或写业务 API；错误 Content-Type 被拒绝。演示身份切换本身仍是公开本地演示功能，不提供真正身份可信度。
- 同键同参数重用，同键跨 invoice/version/mode 冲突；6 个独立 Node 进程对同一 SQLite 数据库竞争，不同 key 仅一个创建成功，其余 ACTIVE_ATTEMPT_EXISTS。
- 旧版审批/报价失效，报价过期/绑定不一致阻断，签名后禁止编辑；UNKNOWN 不开放重付，已有引用不能被替换成成功引用。
- 撤权后附带先前 ETag 的导出请求返回 403（不是 304），仍有 no-store；viewer 从附件接口也无法读取。附件从未包含在 viewer 授权字段中，所以不存在“撤权前可读附件”的功能。
- PAYMENT_MODE=L1/L2 在创建数据目录之前拒绝启动；支付 API 与 DisabledAdapter 拒绝真实模式；没有钱包请求或网络广播能力。

上述是明确输入下的可复现实测，不是全面渗透测试或生产安全认证。

## 复现

```sh
npm ci --cache /tmp/npm-cache
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

仅复核新增权限和进程竞争：`node --import tsx --test tests/security.test.ts`。
仅边界/证据/receipt 回归：`node --import tsx --test --test-name-pattern='review regression' tests/domain.test.ts`。

最新预期：23 项通用服务端 tests、2 项 SQLite Chromium E2E、10 个 PostgreSQL 子场景（Node 含父测试计数 11）和 2 项 PostgreSQL E2E 全部通过。故障隔离测试会输出一条固定 `Verification deferred` 信息，这是预期的故障注入结果；不含账单内容。

## 尚未完成

- PostgreSQL 后续生产工作：本轮已实现关系表、迁移、唯一索引、行锁和 revision CAS 并实测；生产在线升级、数据导入/降级、长期压力与灾备恢复仍未完成，详见 POSTGRES.md。
- 真正身份认证、钱包挑战与签名、独立 worker、KMS/轮换/灾备、生产日志与安全审计未实现。
- L1 真实资产及网络可信验证、真实付款、收款独立核对和退款未运行；L2 权限与可信闭环仍 BLOCKED。
- Library 交付状态以主对话确认的 Library 返回结果为准；本地 ZIP 存在不等于已上传。

2026-10-25 追加复核：PostgreSQL 确实使用 pg/关系表/事务，不使用 SQLite；发现的 invoice 元数据不一致、审计 AAD 记录绑定和纯登录 origin 协议边界均已修复并测试。最新验收以 ACCEPTANCE.md 的 PostgreSQL 追加记录为准，原 22 项/2 项计数为上一轮历史。
