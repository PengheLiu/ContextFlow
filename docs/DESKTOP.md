# ContextFlow Desktop：macOS / Windows

桌面端把自己的模型、Agent 和笔记接到 Chrome 的阅读现场。它内置本地服务与运行环境，负责连接、设置、权限与恢复；浏览器继续负责批注、阅读库、导出和主动同步，不另建第二套阅读器。

普通用户从 [Chrome 商店安装扩展](https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm)开始，需要本地能力时再去[官网下载页](https://pengheliu.github.io/ContextFlow/download.html)。完整操作见[开始使用](GETTING_STARTED.md)；这里说明桌面能力、权限边界及开发验收。

安装与配对请按[开始使用](GETTING_STARTED.md#开启-ai-和笔记同步)操作；维护者可另用 [macOS 完整验证指南](DESKTOP_LOCAL_VALIDATION.md)检查旧服务停用、读写闭环、退出重连、数据保护及回退边界。

## 当前发布状态

**Mac Apple Silicon 桌面端 1.1.0 可从官网下载，提供 DMG 与 SHA-256 校验文件。** 当前 Mac 包尚无 Developer ID 签名、未经过 Apple 公证，系统可能阻止打开；SHA-256 只验证文件字节，不替代系统安全验证。遇到拦截请核对来源并阅读 [Apple 安全说明](https://support.apple.com/zh-cn/102445)，不要关闭 Gatekeeper 或批量移除隔离标记；遇到损坏或恶意软件提示应停止并反馈。

| 目标 | 当前发布边界 |
| --- | --- |
| macOS Apple Silicon | 官网提供 1.1.0 DMG / SHA-256；仅完成维护者本机与隔离验证，未签名、未公证 |
| macOS Intel | 未开放安装包；有独立构建路径，不以 Apple Silicon 结果替代目标机验收 |
| Windows x64 | 未开放安装包；有构建与 CI 路径，不把 EXE 打包成功当作标准用户实机验证 |
| Windows ARM64 | 未开放安装包；运行时准备不等于兼容性、安装或升级验收 |

发行记录：桌面与同版本配套包统一放在 [GitHub v1.1.0](https://github.com/PengheLiu/ContextFlow/releases/tag/v1.1.0)，此次标为 prerelease、非 latest，不覆盖冻结的 v1.0.0；后续签名发行使用新版本。截至 2026-10-23，商店公开扩展为 1.0.0，尚未确认 1.1 已上线；Native Messaging 一键连接需匹配扩展审核发布后更新，下载桌面端不表示 Chrome 审核已通过。保留原扩展和数据，不通过卸载更新。

当前内置 Node 24 的官方 macOS 二进制要求系统 **13.5 或更高**，见 [Node 24.22.1 平台要求](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md#platform-list)。这是桌面运行时前提，不是所有这些系统均已完成产品验收的声明，也不是基础扩展的系统下限。安装包最低系统声明、官网下载页与实际目标机验收必须一致；不能只依据 Electron 或几何助手可运行就宣布整包兼容。

未签名分发与签名发行是不同状态。当前下载如实说明安全与验证边界，不声称通过 Apple 的签名、公证审核。以下关卡仍适用于后续**正式签名发行**，不因当前提供下载而省略：

- Mac Developer ID 签名、公证、票据装订，以及干净机器的正常下载、安装、打开验证。
- Windows 发布者签名；标准用户账号上的安装、登录启动、退出、更新与卸载验证。
- 首发架构分别验收。Mac Apple Silicon / Intel、Windows x64 / ARM64 不因为框架支持就自动宣称全部通过。
- Chrome 扩展的 `nativeMessaging` 权限需经审核发布，桌面发行不替代扩展审核。
- 官网手动下载的签名版本覆盖安装、失败后保留旧应用与数据、本机恢复点回退、睡眠唤醒和多浏览器配置验证。应用内自动下载 / 安装更新不属于本候选承诺。

## 用户流程

1. 安装 Chrome 扩展。高亮、批注、图片补充和 Markdown 导出可以立即使用。
2. 需要 AI / 同步时，从官网下载当前开放的 Mac Apple Silicon 安装包，核对安全说明，将应用放入「应用程序」后打开。应用自动准备连接，展示支持的 Agent 与已登记 Obsidian 库的候选；没有发现不影响基础阅读，也不代表授权失败。
3. 在匹配扩展的「连接与设置」点击「连接桌面端」，再在桌面弹窗核对申请和安装编号、点击「允许连接」。无需终端或手动生成 / 复制配对码；每个 Chrome 配置分别授权。没有入口时先核对上方发行记录。
4. 按需选择自己的模型或支持的 Agent，「测试模型连接」或「测试 Agent 连接」验证当前草稿，之后点击「保存更改」。只同步笔记可跳过 AI；只用 AI 也可以暂不设置笔记。
5. 选择笔记后端与目的地，点击「保存更改」，核对后再点「确认使用这个位置」。选中候选、已有默认路径或保存配置都不等于真实写入。
6. 回文章完成一次真实回答，或在侧栏点击「同步」并检查目标文件 / 文档。没有新改动的同步显示完成，但不能充当首次写入验证。

正常用户不需要预装 Node、npm、Git、终端或 WSL。第三方模型额度与 Agent 的安装、登录不随 ContextFlow 提供；需要 WSL 的 Agent 是可选能力，不是基础功能前提。桌面连接按 Google Chrome 验证，不把 Chromium、Edge、Brave 的基础阅读可用等同于桌面已适配。

高级 CLI 配对是独立的折叠兼容入口，不是桌面安装流程；正常路径始终是一键请求、桌面确认，不在桌面端生成配对码。

## 界面与状态

- **首次准备**：先显示界面，再在后台自动启动本地连接、并行发现已安装 Agent 与 Obsidian 已登记库。可返回、跳过与续接；发现不等于授权或实际回答验证。
- **首页**：浏览器授权、当前 AI 测试、笔记确认与实际同步分别显示，一个明确的下一步。默认路径非空不算确认；无变化同步不冒充首次写入验证。
- **AI 助手 / 笔记**：复用同一个 Settings 实例、服务配置和连接测试记录，按任务展示。选择器紧贴字段，跨页面保留草稿，轮询不移动表单或抢走焦点。读取授权与笔记写入位置分开确认。
- **设置与帮助**：浏览器实例授权与独立撤销、登录启动、服务管理、脱敏诊断、官网下载更新和本机恢复点。正常首页不展示服务控制台，不提供自动下载安装。正式签名资源只允许官方商店 ID，开发构建另允许固定开发 ID。

完整跨端规范见 [产品体验规范](DESKTOP_PRODUCT.md)。官网的普通流程为扩展优先，再由专用 `download.html` 承接桌面安装；旧 CLI 保留为高级兼容路径。初次准备完成不代表所有可选能力已验证，应回文章完成真实回答或同步。

关闭窗口不退出应用或停止服务；Mac 保留 Dock 作为菜单栏之外的找回入口，Windows 托盘不可用时保留最小化窗口。Dock 恢复失败则保留原窗口，不同时丢失入口。菜单栏使用专用黑色透明 1x / 2x 模板，点击显示服务状态、运行/排队任务数及「打开 ContextFlow」「设置与帮助」「退出 ContextFlow」。Mac 初始位置优先靠右；通过 AppKit 屏幕几何检查确认刘海或屏幕边缘遮挡时，仅重置本应用的位置一次。AppKit 的位置存储约定不是系统强制定位保证，第三方菜单栏管理器仍可能隐藏图标；因此不再把非零 bounds 当成实际可见证明，也不因此隐藏 Dock。

从菜单栏、托盘或应用菜单选择「退出 ContextFlow」才会停止服务，有任务时先确认。崩溃最多尝试恢复三次，不重放模型请求。检测到旧服务时不启动第二份，也不按端口强杀任意进程。重复启动同一构建只唤起原窗口；若旧进程仍占有单实例锁，新构建明确提示先退出旧版，不能把唤起旧版当成新安装成功。Mac 从磁盘映像或构建目录运行时，先提示安装到「应用程序」，不注册临时路径为 Chrome 桥接入口。

macOS 仅在用户确认、已识别旧 ContextFlow LaunchAgent 且没有运行 / 排队任务时接管旧服务；手动运行的服务需在原终端停止。接管保留原数据位置。保存配置后密钥会加密，之后请通过桌面端管理服务。

## AI 与笔记是独立的能力

翻译始终使用 LLM；解释和速览可选择 LLM 或 Agent。模型列表获取成功不代表回答可用，固定短消息测试通过也不代表笔记检索或完整权限已经验证。

Agent 的安装检测不调用模型；连接测试需主动触发，使用固定短消息，不运行工具、不读取笔记、不保存草稿。测试结果绑定程序身份、版本、待保存权限档与服务端凭据。选择程序或已登记 Vault 不自动授予 Agent 读取权限，写入目的地与「允许读取的笔记库」分别设置。

新配置默认 Safe。Codex 与 Claude Code 有受限适配，但隔离机制及验证程度不同；DeepSeek Harness 的受限连接测试不意味着 Safe 阅读已开放，实际阅读仍需 Full；Gemini 等未验证工具不可仅凭检测到程序就宣称安全可用。支持范围以设置页实际提示和对应版本为准，不为通过首次测试自动升权。Full 可涉及命令与文件写入，需单独确认风险。

## 更新而不丢失记录

扩展通过 Chrome 商店单独更新。桌面端采用官网手动更新：保存工作、导出浏览器完整备份，等待任务结束，从应用菜单正常退出旧版，再下载当前实际开放的匹配系统 / 架构版本，核对安全说明和校验文件，覆盖应用文件而不删除用户数据。重新打开后核对版本、浏览器连接、模型和目的地；正常覆盖安装不要求重新配对。

当前官网 Mac Apple Silicon 包未经过 Developer ID 签名和公证，不把提供下载等同于签名发行或干净机器全面验收。桌面端不承诺后台自动下载、自动安装或已经验收过签名自动升级。将来启用此能力前需单独验证签名、各架构路由、任务保护、失败恢复与数据保留。

## 数据、安全与恢复范围

既有数据继续使用用户的 `.contextflow` 目录，不静默搬迁活跃的 SQLite 数据库。桌面状态位于 Mac 的用户 Application Support / ContextFlow 或 Windows 的 LocalAppData / ContextFlow，与应用安装文件分离。

桌面端保存配置时加密模型 API key、思源 token 和 Agent 环境配置；加密主密钥通过 Electron safeStorage 使用系统凭据保护保存。阅读数据库和图片本身**不宣称加密**。没有系统密钥的独立命令行服务会拒绝读取加密配置，不覆盖成默认配置。

本机恢复点包含停止服务后的数据库、内容寻址图片、配置和受系统保护的加密密钥。只适用于原电脑的系统账号，不是跨电脑备份；不包含扩展 IndexedDB 中尚未同步的记录，不恢复已撤销的浏览器授权。恢复前创建保护副本，先校验文件清单和哈希，启动失败尝试回退。旧恢复点不会自动删除。

浏览器完整备份仍需在扩展阅读库单独导出。本机原始日志可能含个人信息，不可直接公开。诊断只导出字段白名单，不包含文章、网址、路径、密钥或原始日志。

桌面界面采用 sandbox、contextIsolation、禁用 Node integration、固定 IPC 白名单与本地 CSP。匹配扩展通过 Native Messaging 发现、唤醒和请求实例授权；任务、流式结果和图片仍走鉴权的回环 HTTP，不在渲染界面暴露系统命令或通用文件接口。商店 1.0 的旧 CLI 配对不自动成为桌面实例授权。

连接后浏览器记录与图片也会持久化到本机服务；它与写入外部笔记软件的主动同步不同。真实回答、连接测试与同步完成通过子进程 IPC 通知桌面重新读取原子配置 / 健康状态帧。`reading-status.json` 仅存有界 HMAC 身份、结果类型与时间，不存回答、网址、路径或密钥。实际回答与测试、无变化同步与真实写入、缓存与新连接验证分别计算。

## 开发与构建

以下为开发者构建路径，不是普通用户安装步骤。使用 Node 24 与 npm；Mac 还需 macOS 构建机与 Xcode Command Line Tools，以编译 AppKit 几何助手。开发桌面端默认与已安装版共用个人数据 / 状态位置，不要把它当作隔离沙盒：先备份并退出旧应用；自动化验证使用下面的隔离 smoke 路径。

```sh
npm ci
npm run desktop:install
npm run desktop:dev
```

构建时下载固定版本 Node，校验代码里固定的 SHA-256，并携带许可证；不读取维护者个人配置。最终用户首次启动不执行 npm、不下载运行时。

服务生产依赖必须以独立 `extraResources` FileSet 复制 `build/core/node_modules → core/node_modules`；构建器的默认过滤会忽略嵌在 `core` 根映射里的 `node_modules`。回归测试使用真实资源复制器校验 SDK、WebSocket 及生产传递依赖；验包工具将实际 core 与运行时复制到仓库外启动，避免借用开发仓库依赖而误通过。内置 Node 不继承 `NODE_OPTIONS` / `NODE_PATH`，并关闭全局模块搜索。

```sh
npm run test:desktop
npm run desktop:prepare
npm run test:desktop:smoke
npm run desktop:dist
node tools/check-desktop-package.mjs
```

`test:desktop` 是自动回归，不代替消费者安装验收；`test:desktop:smoke` 使用临时状态与服务数据，但会创建真实测试窗口 / 菜单栏图标。它证明当前系统上的生命周期和代码路径，不证明所有用户菜单栏都实际可见。键盘、长路径、最小窗口和 200% 缩放的隔离 UI 验收可运行 `CONTEXTFLOW_DESKTOP_LAYOUT=1 node --test test/desktop-layout.test.mjs`。Windows PowerShell 需先用 `$env:CONTEXTFLOW_DESKTOP_LAYOUT='1'` 设置该变量，再运行测试。

可交付的 DMG / EXE / ZIP 与匹配的更新元数据在 `release/desktop/`，不会自动上传。未打包的 `.app` / `win-unpacked` 固定留在 `release/.desktop-build.noindex/`，不再与安装包放在同一目录，也不复制到交付目录。

`desktop` 的 `pack` / `dist` 经 `tools/package-desktop.mjs` 调用构建器：只复制本次返回的安装文件，不扫描并重新交付旧包。`pack` 只构建未打包应用，不产生用户安装副本。不要用 `--config.directories.output` 覆盖输出；本轮预览想单独保存交付包，可用：

```sh
npm run desktop:prepare
npm --prefix desktop run dist -- --mac --arm64 --artifact-subdir product-preview
```

此时安装包在 `release/desktop/product-preview/`，可运行暂存应用仍位于 noindex 目录。准备目录 `desktop/build/` 和 noindex 构建目录一次只处理一个目标，不要并发构建不同系统 / 架构。

Mac 默认 `--mac` 同时生成 DMG 与 ZIP。只需本机安装验证可加 `--target dmg`（也兼容 `--mac dmg`），减少归档耗时。生成 ZIP 或更新元数据不代表已提供自动升级；当前以官网手动安装为准。Windows 可用 `--win --target nsis`。

Apple 的 [Spotlight 符号查找文档](https://developer.apple.com/documentation/xcode/locating-a-missing-debug-symbol-file)明确要求可索引路径不要包含 `.noindex`，这里反向利用该目录约定避免新构建副本进入 Spotlight。它**不是 LaunchServices 注销 API**：Apple 说明 [Finder 发现应用时仍可能注册应用](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/LaunchServicesConcepts/LSCConcepts/LSCConcepts.html)。不要在 Finder 中打开暂存 `.app`，真实体验应通过 DMG 安装到「应用程序」。已有构建副本及历史注册需另行核对处理；本构建工具不会移动、注销现有应用、清空系统索引或停止进程。

Windows x64 原生或交叉构建（交叉打包不等于 Windows 上运行通过）：

```sh
npm run desktop:prepare -- --platform win32 --arch x64
npm --prefix desktop run dist -- --win --x64
```

Mac Intel 构建需同时选择正确的运行时与 Electron 架构：

```sh
npm run desktop:prepare -- --platform darwin --arch x64
npm --prefix desktop run dist -- --mac --x64
```

通过 `--release` 准备正式资源会关闭开发扩展 ID。该标志不代替签名、公证与验收。证书和密码应由安全的 CI 配置提供，不写入仓库。双平台流程见 `.github/workflows/desktop.yml`；PR 构建只能生成预览产物，不公开发布。

## 必须在目标系统验证

- 无 Node/npm 的全新标准用户，中文 / 空格用户名和目录。
- 两个 Chrome 配置分别配对、重配和撤销，互不影响。
- Agent 未安装、未登录、已登录、自定义入口；取消后无残留进程树。
- 服务冲突、系统重启、休眠恢复、浏览器重启。
- 有任务时拒绝重启 / 更新 / 创建恢复点，退出有清楚确认。
- 官网手动覆盖安装、签名验证、恢复校验失败与启动失败回退；自动升级不在本次承诺内。
- Windows 卸载清理自己的注册项，保留用户数据；Mac 删除应用后的失效桥接能给出明确下一步。
- 插件与桌面端错峰升级；未安装桌面端仍能完成基础阅读。
