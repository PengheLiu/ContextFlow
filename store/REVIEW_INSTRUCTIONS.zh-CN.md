# 1.1.4 审核指引

2026-11-13，1.1.4 已在 ContextFlow 原商店条目提交。后台显示「已将您的扩展程序提交送审」及「状态：待审核」。提交时勾选审核通过后自动发布。公开更新清单记录的扩展版本为已核实公开的 1.1.3。

冻结功能源码为 `6917096ba37d4311ba9f81c792eff2a2c7506c32`。上传文件为 `contextflow-chrome-1.1.4.zip`，SHA-256 为 `fc22b8271bb969e40068fb0dbac38da16290ef39dafe1d35c229428e7f1ef815`。本版兼容性修复和验证范围见[更新说明](../docs/RELEASE_1_1_4.md)和[发布准备清单](../docs/RELEASE_READINESS.md)。

历史回执见 [1.1.3 发布记录](../docs/RELEASE_1_1_3.md)和 [1.1.1 审核归档](./archive/REVIEW_INSTRUCTIONS_1_1_1.md)。

后台保存的审核说明如下，用户名与密码字段留空。上传草稿已核对为 1.1.4，manifest 除版本号外与公开版 1.1.3 一致。

## 可粘贴说明

无需账号即可测试基础功能。打开 https://pengheliu.github.io/ContextFlow/demo.html ，选择正文点「批注」，输入内容或贴图，刷新确认批注保留，在侧栏点「下载」导出 Markdown。「我的阅读库」可搜索与备份恢复。1.1.4 权限与 1.1.3 一致。可选 DSH 验证：从 https://pengheliu.github.io/ContextFlow/download.html 安装 macOS 13.5+ Apple Silicon 桌面端，在扩展内点「连接桌面端」并在客户端批准。使用已登录的 DeepSeek Harness 0.2.2-rc.2，在设置页选择本地 Agent 并测试连接、保存，再回练习页选中文字点击「解释」，可继续追问。「模型连接」只验证固定短消息；若检测到尚未适配的 DSH 版本，设置页会提示网页回答需更新。AI 使用用户的账号和额度，基础功能无此要求。Mac 安装包未使用 Developer ID 签名或 Apple 公证。

## 权限与远程代码理由

- `alarms`：定期检查官方公开版本清单，最多每 6 小时自动检查一次，发现已发布新版后提示更新。任务不调用 AI、不发送阅读内容或凭据，不自动重载扩展或刷新阅读页面。
- `https://pengheliu.github.io/ContextFlow/*`：仅读取固定公开 JSON `https://pengheliu.github.io/ContextFlow/updates.json`。请求不附带文章、笔记、密钥、配对凭据或设备标识；校验响应中的版本、平台和固定目标网址，不下载或执行远程代码。
- `storage`：保存站点偏好、本机配对凭证和版本检查结果；凭证只向受信任的扩展上下文开放，不使用 Chrome 同步存储。阅读记录和图片位于扩展自己的 IndexedDB。
- `nativeMessaging`：在用户主动连接后，唤醒本机 ContextFlow 客户端并由客户端确认该浏览器授权。不用于任意命令执行，不遍历其他 Chrome 用户配置，不读取浏览器历史；基础功能无需桌面端。
- `http://127.0.0.1:7317/*`：受配对认证的本机连接，用于用户自己的 AI、Agent 及主动笔记同步；不是开发者远程采集端点。
- 不使用远程代码。执行脚本和 Markdown / 数学渲染依赖均随 ZIP 打包；公开版本 JSON 和 AI 回答只作为数据、内容处理，不通过 `eval`、远程脚本或模块导入执行。

## 提交前及提交后核对

- 原商店 ID 为 `aemncphfnlpbhlddifhohpgegejjejfm`。已核对上传包版本、11 个顶层文件、SHA-256，以及 manifest 无 `key` 和维护者凭据。
- `alarms`、官网主机权限、`storage`、`nativeMessaging` 和本机 HTTP 权限与 1.1.3 一致，继续使用现有权限说明。
- 隐私政策为 https://pengheliu.github.io/ContextFlow/privacy.html 。网站内容、功能涉及的 URL / 标题及认证信息按真实用途披露；不勾选“不处理任何用户数据”，不宣称所有 AI 请求离线，也不提供私人账号、API key、配对码或 Agent 凭据。
- 基础功能可直接使用官网练习文章验证。桌面端与模型属于可选配置；AI 使用用户账号及额度。Mac ARM64 安装要求、未 Developer ID 签名 / 未 Apple 公证等限制在官网如实说明，未开放平台不提供假下载。
- 保存后台审核说明，在原条目提交审核。提交后核对 **1.1.4** 和审核状态。
- 实际公开后再更新 `publishedExtension.version` 和官网更新清单。
