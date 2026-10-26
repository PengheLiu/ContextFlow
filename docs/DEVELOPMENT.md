# 开发与发布

**公开版与候选源码分开管理。** [Chrome 商店](https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm) 1.0.0 已于 2026-10-21 上线；GitHub v1.0.0 是冻结的既有扩展 / CLI 发行。当前源码正在准备 **1.1.0 候选版**，包含桌面端和新增 `nativeMessaging` 连接流程，尚无签名桌面安装包公开发行，不能覆盖 1.0 附件来发布这些更改。

版本、渠道和各平台状态以 [`product/release.json`](../product/release.json) 为当前机器可核对来源；历史过程见 [1.0 发行说明](./RELEASE_1_0.md)与 [store/REVIEW.md](../store/REVIEW.md)，历史“待审核”记录不等于当前商店状态。

普通用户请先看[安装与使用指南](./GETTING_STARTED.md)。这里面向修改源码、运行测试或维护发行包的开发者。

## 从源码运行

开发仓库推荐 Node.js 24，与桌面 CI 保持一致；CLI 服务的最低运行版本仍为 Node.js 22.13+。扩展最低为桌面 Chromium 111+。构建 macOS 桌面包还需要 macOS 构建机及 Xcode Command Line Tools；普通安装用户不需要这些开发工具。

最低版本依据：Node 的 [SQLite 版本历史](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)表明，22.13 起无需额外实验启动参数。本项目直接使用内置 SQLite，不能仅因该模块在 22.5 出现就把 22.5 当成开箱可用的最低版本。

```bash
git clone https://github.com/PengheLiu/ContextFlow.git
cd ContextFlow
npm ci
npm run build:ext
```

在 `chrome://extensions` 开启开发者模式，加载 `extension/dist`。仅使用离线批注，无需运行服务。开发版与商店版的 ID / 私有存储不同，不要同时启用两套面板；更换前先导出要保留的记录。

桌面联调按 [桌面构建与验证](./DESKTOP.md)准备匹配版本。只调试 CLI 时，在项目目录运行 `npm run server`，再按扩展连接页命令独立配对；macOS CLI 常驻管理另见后文。已有桌面端或旧服务运行时，不再同时启动 CLI。桌面加密后的配置不能直接交给旧 CLI，遇到拒绝读取不要删除配置。

开发构建保留兼容用的本机 token，不可公开分发。面向其他用户必须使用下方的商店构建。

开发桌面端默认使用真实用户的桌面状态目录；仅设置 `CONTEXTFLOW_DIR` 只隔离服务数据，不能同时隔离浏览器桥接和桌面设置。自动验收使用 `test:desktop:smoke` 的独立临时状态，不读取个人浏览器资料、不注册测试版 Chrome Native Host。手动运行 `desktop:dev` 前先保护数据并退出已安装版本。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 核心 / 扩展回归，结束后自动运行商店专项测试；不包含所有桌面与 GUI 验收 |
| `npm run build:ext` | 个人开发扩展，输出到 extension/dist |
| `npm run build:store` | 无发布者凭据的商店 ZIP，输出到 release |
| `npm run test:store-support` | 验证配套服务安装、配对和撤销 |
| `npm run build:store-support` | 本地服务 ZIP 和静态支持网站 ZIP |
| `npm run build:skill:public` | 独立的公开浏览器 userscript，非 Chrome 商店包 |
| `npm run test:desktop` | 桌面、配对、状态、恢复与打包的自动回归 |
| `npm run test:desktop:smoke` | 在已准备运行时上创建隔离原生窗口，验证当前系统生命周期，不替代消费者安装验收 |
| `npm run build:website` | 构建静态官网，不部署 |
| `npm run test:product` | 发布状态、证据规则、公共入口与文档一致性回归；模拟证据不是实际签名 / 安装证明 |
| `npm run check:product` | 只读核对候选、已公开版本和各平台状态；默认离线，不是正式放行 |
| `npm run check:public-surface` | 联网检查已公开版本 companion 与官网四个入口的可达性，包括桌面下载页 |

## 发布

同步维护根目录和 `desktop/` 的 `package.json` / 锁文件，以及 `product/release.json` 的候选版本与发布状态，再测试和构建。当前候选为 1.1.0。已经上传过商店或公开发行的版本不能用新内容覆盖；新版本号、本地 ZIP、Git tag 与商店上线是四种不同证据。

商店 ZIP 根目录必须是 manifest.json 及扩展文件，不能混入 Node 服务、开发者配置或个人数据。使用已有商店条目更新，保持 ID `aemncphfnlpbhlddifhohpgegejjejfm`。

文案、隐私页、审核记录在 [store](../store/REVIEW.md)。v0.3.1 已于 2026-10-19 在公开商店确认上架；v0.3.2 同日先发布配套服务，再提交已有商店条目审核，设置为通过后自动发布。v0.3.2 标签固定在 `f4356a2`，发行附件不覆盖已发布版本；后续文档状态更新不改变该安装包。

更新支持站点时只发布静态页面；确认公开隐私 URL 和发行下载链接可用。不要把静态 ZIP、本地构建或商店草稿状态当成已经上架。

官网为 https://pengheliu.github.io/ContextFlow/ 。`npm run build:website` 只构建白名单静态文件；`npm run deploy:website` 默认预览发布范围，显式追加 `-- --publish` 才写入现有 Pages 分支。完整预览、检查与发布步骤见 [官网部署说明](../store/DEPLOY.md)。官网独立发布，不必重新送审扩展或覆盖 Release 附件。

桌面端采用官网手动更新，不启用尚未验收的应用内自动下载 / 安装。用户应在空闲时正常退出旧版，再用官网实际开放、系统与架构匹配的安装包覆盖安装，核对该包的签名 / 公证状态与校验文件，保留数据与配对。当前独立分发包不冒充签名发行；自动升级若以后开放，需要单独验证签名、架构路由、任务保护和失败恢复。

1. 冻结候选版本，完成核心、桌面、包隔离和目标系统验收；Mac 各架构、Windows 各架构分别记录，不用交叉打包成功代替实机验证。
2. 为本次明确开放的平台验证安装、运行与覆盖升级的数据保留，公开匹配安装包和校验文件。独立未签名分发如实说明缺少签名 / 公证及实际验收范围；若按正式签名渠道发行，还必须完成目标平台签名、公证（适用时）与干净目标机验收。未开放平台保持明确状态，不制造下载链接，也不降低严格签名发行门禁。
3. 部署包含 `download.html`、支持与隐私说明的静态官网。用未登录访问核对实际下载、签名与版本，不把本地 `release/website` 当成线上成功。
4. 若保留高级 CLI 路径，先公开同版本 companion；运行 `npm run check:release-links -- --website` 核对候选版本服务包 / SHA、隐私及四个官网入口。默认不加 `--website` 只检查 companion / SHA 与隐私。`npm run check:public-surface` 则检查已公开冻结版本与官网，不能混成候选已发布；以上均不代替签名 / 实机证据。
5. 在原 Chrome 条目上传新版本，核对新增 `nativeMessaging` 权限、数据用途、真实截图及完整安装路径，再提交审核。通过后从公开商店核对实际版本，不能只依据 GitHub Release 或后台草稿宣称上线。

扩展连接页按自身版本生成服务包链接，不允许已公开界面指向 404。支持站点与旧版兼容指南可独立更新，不冒充扩展运行时更新。新版桌面主流程与旧版 CLI 文档必须同时可辨，不能把源码预览当成商店 1.0 用户已有能力。

正式发行证据核对使用 `npm run check:product -- --release --manifest /path/to/release-manifest.json`。它要求源码 / tag / 安装包与逐目标验收报告绑定，检查文件、哈希及实际命令结果，不接受 `signed=true` 或 `tested=true` 替代证据。该只读门禁不替你执行签名、公证、安装、升级、部署或商店送审；默认离线状态检查通过、模拟测试通过都不能当作正式可发布。真实性仍须维护者审查。

完整首次使用验收（需 Playwright 与 Chromium）：

```bash
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime node test/onboarding-browser.test.mjs
```

测试会解压真实 companion ZIP，执行连接页实际复制的安装 / 配对 / 启动命令，并核对笔记文件与服务重启。模型使用隔离模拟服务，不调用用户的真实模型或笔记目录。不能用这个测试代替 Windows / Linux 实机或真实上游服务的验证。

## 配置与服务

配置位于 `~/.contextflow/config.json`，也可使用 `CONTEXTFLOW_DIR` 指定隔离目录。

| 配置 | 用途 |
| --- | --- |
| explain.backend | llm / agent |
| agent.id、agent.notesDir | 本地 agent 及授权笔记目录 |
| agent.profile | safe / full；完整权限需显式确认 |
| translate.chunkChars | 每轮提供的正文长度；0 为不带正文上下文 |
| sync.backend | markdown / obsidian / siyuan |
| allowedOrigins | 私人脚本的来源限制；已配对扩展无需手改 |

macOS **CLI 服务**管理：`npm run service -- status`、`restart`、`logs`、`uninstall`。移动项目或 Node 路径后重新安装常驻服务。这些命令不是桌面端日常操作；桌面应用会自动管理自己的服务，用户从「设置与帮助」处理问题，不叠加旧 LaunchAgent。

`npm run pair -- --revoke <扩展ID>` 会立即撤销对应扩展授权；不需要重启服务。诊断日志与反馈中不得包含配对码、API key 或笔记内容。

更多架构背景见 [DESIGN.md](../DESIGN.md)。

## 本地 Agent 进程复用与任务流

Codex 默认通过本地 `codex app-server` 的 stdio JSON-RPC 接口运行。相同账号、权限档与笔记目录复用进程，同一文章的速览与解释复用线程；文章正文、上下文分段设置或 Codex 配置发生变化后重新建立线程。线程只存在于当前进程，空闲五分钟后释放；退出、取消或失败后，由阅读数据库重建上下文，不续接旧 `codex exec` 留下的临时 session ID。

Safe 保持只读沙箱和禁止提升权限。由于 app-server 没有 `exec --ignore-rules` 的等效开关，此路径关闭内置 shell、代码执行、子 Agent 和电脑操作，通过 `contextflow_search_notes` / `contextflow_read_note` 读取显式授权目录中的文本笔记；工具检查路径、符号链接、文件大小与返回内容上限。既有 Codex 服务配置仍用于认证；Full 继承用户沙箱配置，本版没有交互审批界面，不自动批准额外授权请求。

DSH 以桌面版为主要接入目标，目前验证 macOS DeepSeek Harness `0.2.1-rc.2`。检测和实际调用共用安装发现逻辑，默认优先 `/Applications/DeepSeek Harness.app`，其次 `~/Applications/DeepSeek Harness.app`，最后才是 PATH 中的独立 CLI。无需另装命令行版或修改 PATH；设置页会显示当前使用的来源和版本。`CONTEXTFLOW_DSH_BIN`（或 `agent.env.CONTEXTFLOW_DSH_BIN`）可指定自定义安装入口；显式入口不存在时不会偷偷切换安装。

桌面版使用应用包内的 Electron/Node 和 profile-boot 接口启动独立后台进程，继承原 `desktop` profile 的账号、模型与工具配置。ContextFlow 的小型启动入口仅追加工作进程隔离设置：禁用定时任务与产品遥测，将会话、存储和索引放入独立临时目录/内存；不会修改原 profile。后台在 `127.0.0.1` 随机端口提供认证 HTTP 请求和 WebSocket 事件；连接使用该子进程提供的认证信息。同一配置复用进程，同一文章复用会话，不会连接、操控或关闭用户正在使用的桌面窗口。DSH 仍仅支持 Full；连接不提供额外交互授权。会话映射只在 ContextFlow 内存中保存，工作进程退出时清理临时状态；空闲五分钟或异常退出后，从 ContextFlow 阅读记录重建新会话。

DSH 的连接测试独立于阅读权限：已验证的桌面版本可直接测试登录和默认模型回答，普通 Safe 阅读仍未开放。测试只加载内置认证/模型组件并发送固定短消息，不启动 Agent loop、工具、MCP、技能或用户自定义插件，不携带文章、笔记路径或阅读会话；收到工具调用就报告失败。只接受可安全解析的官方模型配置，不执行配置中的 JavaScript，也不会静默替换默认模型。该测试使用独立进程，45 秒超时，可取消，结束后清理；不会回退到 Full 或旧 CLI。

Agent 的结构化事件进入作业队列，经带认证的 `GET /jobs/:id/stream` SSE 推送。扩展通过 Service Worker 内的 fetch 和 runtime Port 转发，配对令牌不进入页面或 URL。答案预览仅保存在界面内存中；只有成功终态才提交阅读记录。事件流不可用时转回轮询，绝不重新提交任务。

升级 Codex 后应验证本机 app-server 协议；只有明确不兼容且尚未提交模型任务时才允许回退到原 `exec` 路径。超时、认证失败和执行中断不会自动重放。`CODEX_HOME` 会传给 Codex 子进程，macOS 服务安装也会记录安装时显式指定的该变量；已安装服务需重新运行安装命令，或在本地配置的 `agent.env.CODEX_HOME` 中指定配置目录。

独立 DSH CLI `0.1.0-rc.6` 保留旧 Web 协议兼容，旧协议仍按原机制在 DSH_HOME 保存会话；独立 CLI 仅在明确不支持协议且尚未提交提问时回退到一次性的 headless 调用。未验证的桌面版本直接报告兼容性问题，不会自动切换到旧 CLI；认证失败、流中断或提交状态不明时也不会重放任务。`DSH_HOME` 与 `CONTEXTFLOW_DSH_BIN` 会传给子进程，并由服务安装脚本保留，也可在 `agent.env` 中显式指定。桌面版升级后需重新验证其启动 API 和会话协议。

相关测试使用临时目录、模拟 app-server 和模拟 HTTP 服务，不读取个人登录凭据或请求真实模型：

```bash
npm run test:codex
npm run test:dsh
npm run test:stream
```

本机已安装桌面版时，可额外运行 `npm run test:dsh:installed`。该测试用真实桌面运行时连接临时本地假模型，验证流式回答、连续提问复用进程与会话、失败不保存答案，以及退出清理。测试创建独立 HOME/DSH_HOME、拦截外部网络，既不读取个人登录配置，也不调用真实模型。旧 CLI 的隔离验收单独保留为 `npm run test:dsh:legacy:installed`。

`npm run test:dsh:connection:installed` 验证受限连接测试：真实桌面模型组件连接本地模拟模型，确认没有工具、用户插件不加载、恶意工具输出被拒绝，以及取消/退出清理。此命令也不会调用真实模型。

## Markdown 与扩展加载

Markdown 预览的格式范围、数学渲染、安全边界与验收样文见 [Markdown 兼容说明](./MARKDOWN.md)。

修改渲染依赖或打包参数后，还需验证真实扩展加载，而不只是测试网页中的渲染：

```bash
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime node test/extension-load-browser.test.mjs
```

此测试使用隔离 Chromium 配置，分别加载开发包和商店构建，验证 service worker、阅读页注入和设置页；不会读取个人浏览器资料、配对码或调用模型。构建同时检查 Chrome 的严格 UTF-8 要求，拒绝未转义的 Unicode 非字符（例如公式库可能包含的 U+FFFF）。

## README 产品截图

首页使用真实扩展界面，不在 HTML 中仿制功能面板。原创样文位于 `assets/readme/reading-article.html`，截图脚本会创建临时扩展与浏览器配置，实际输入批注，验证侧栏镜像和 Markdown 导出，然后生成 `assets/readme/inline-annotation.png`。

```bash
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime node tools/capture-readme.mjs
```

该运行目录需已安装 Playwright 与支持扩展的 Chromium；也可通过 `CONTEXTFLOW_CHROMIUM_PATH` 指定浏览器。截图不读取个人浏览器资料、不需要模型或本地服务。更新画面时同步核对 README 的版本说明。
