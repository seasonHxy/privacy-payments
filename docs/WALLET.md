# NEAR 钱包登录客户端（2026-10-25）

本轮实现客户端 NEP-413 登录适配，未连接真实钱包、创建账户或执行交易。默认仍使用 L0 演示身份。真实认证需要 PostgreSQL、精确 origin、可信 testnet RPC/genesisHash、成员映射，并在私有认证配置中添加 `walletId`。缺失钱包配置时 UI 显示“待配置”，不回退为演示身份。

## 官方协议与实现

核对 [NEAR 当前钱包连接文档](https://docs.near.org/tools/near-connect)、[官方登录教程](https://docs.near.org/web3-apps/tutorials/wallet-login)、其链接的 [NEAR Connect 源码](https://github.com/azbang/near-connect)，并检查标准 npm 注册表包 `@hot-labs/near-connect@0.11.4` 的 `NearConnectorOptions`、`NearConnector_ConnectOptions`、`SignMessageParams` 和 injected transport 实现。版本和完整性固定于 lock 文件。

使用真实 SDK 的 `NearConnector`、经 `InjectedWallet` 实例校验后对固定对象调用 `signIn({network:'testnet'})`、`getAccounts({network:'testnet'})`、`signMessage({message,recipient,nonce,signerId,network})`。nonce 从服务端 Base64 解码为恰好 32 字节 Uint8Array，不生成替代消息。返回的账户必须与用户指定、服务端挑战绑定的账户相同；验签和当前链上公钥授权最终由服务端负责。

SDK 在构建时通过固定版本 esbuild 打包为同源文件 `public/generated/wallet-sdk.js`，不使用第三方 CDN。`npm run build`、`npm run dev` 自动生成；生成包不纳入 Git 或源码 ZIP。

## 有意限定的支持范围

只支持用户明确选择、支持 testnet + signMessage + signInWithoutAddKey 的 injected 浏览器钱包。尚未确认具体用户钱包可用性，不声称所有钱包都支持。配置 `walletId` 必须来自该钱包实际官方标识；没有默认猜测。

使用空 manifest 禁止 SDK 默认远程下载钱包执行代码，`autoConnect:false`，不调用选择器弹窗或动态注册钱包，也不更改 CSP。SDK 的连接选择只存内存，不保存访问密钥。SDK 内部会初始化 IndexedDB，但本适配未写入钱包执行脚本或账户私钥。

不传 `signIn` 合约配置、不传 `addFunctionCallKey`，不调用 signAndSendTransaction 或任何交易发送方法。登录没有请求新增访问密钥或持久花费权限。现有账户的 FullAccess 公钥只用于后端验证；这不授予应用 FullAccess。

拒签、错账户、过期或验签失败保持未登录。客户端串行一次登录请求；nonce 原子消费和会话固定防护仍由 PostgreSQL 服务端实施。退出先撤销服务器会话，再尝试钱包 disconnect；退出不保证扩展自行保存的数据删除。

Web 钱包 redirect/callback、WalletConnect、新账户创建、实际钱包互操作未实现或未运行。支持范围扩展需要确认具体钱包，不应为了兼容关闭 origin 或 nonce 检查。扩展本身及浏览器环境属于信任边界。

## 本地验证

`tests/browser/wallet.spec.ts` 在浏览器通过官方 `near-wallet-injected` 事件提供受控 fixture 钱包，运行真实打包 SDK；模拟 API 返回一次性挑战，Node 内存 fixture 用 NEP-413 精确字节签名，并在验证端重新验签。覆盖成功、拒签、错账户、伪造 parent-frame postMessage 拒绝、nonce/域名/网络/账户传递、无新增访问密钥参数、无 localStorage 会话和无演示回退。

这是浏览器协议 fixture 验证，不是真实钱包或 RPC 验收。真实服务端持久挑战、角色映射和并发验证由独立 PostgreSQL 认证测试覆盖。

```sh
npm ci --cache /tmp/npm-cache
npm run build
npx playwright test tests/browser/wallet.spec.ts
```

新增 `tests/postgres/wallet-browser.test.ts` 使用真实 Chromium、同源 Express API、NearAuth 与真实 PostgreSQL，只有钱包扩展和只读 RPC 使用 mock；断言实际 challenge 已消费、会话持久化、刷新仍登录、退出后 HTTP 401 与撤销状态。未用路由模拟服务端认证。

独立审查修复：SDK 本身接受 parent-frame 消息注册；仅检查 manifest.type 不足。现在要求 SDK 实际 InjectedWallet 类实例，固定已核对对象再调用 signIn/signMessage，避免异步按 walletId 重新解析被替换。扩展代码或同源 XSS 仍在浏览器信任边界内。
