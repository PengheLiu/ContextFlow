# 开发与发布

普通用户请先看[安装与使用指南](./GETTING_STARTED.md)。这里面向修改源码、运行测试或维护发行包的开发者。

## 从源码运行

需要 Node.js 22.13+ 和桌面 Chromium 111+。

最低版本依据：Node 的 [SQLite 版本历史](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)表明，22.13 起无需额外实验启动参数。本项目直接使用内置 SQLite，不能仅因该模块在 22.5 出现就把 22.5 当成开箱可用的最低版本。

```bash
git clone https://github.com/PengheLiu/ContextFlow.git
cd ContextFlow
npm ci
npm run build:ext
```

在 `chrome://extensions` 开启开发者模式，加载 `extension/dist`。仅使用离线批注，无需运行服务。需要服务时，在项目目录运行 `npm run server`；macOS 也可使用 `npm run service`。再按扩展选项页的命令独立配对。

开发构建保留兼容用的本机 token，不可公开分发。面向其他用户必须使用下方的商店构建。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 完整测试，结束后自动运行商店专项测试 |
| `npm run build:ext` | 个人开发扩展，输出到 extension/dist |
| `npm run build:store` | 无发布者凭据的商店 ZIP，输出到 release |
| `npm run test:store-support` | 验证配套服务安装、配对和撤销 |
| `npm run build:store-support` | 本地服务 ZIP 和静态支持网站 ZIP |
| `npm run build:skill:public` | 独立的公开浏览器 userscript，非 Chrome 商店包 |

## 发布

先递增 `package.json` 和锁文件版本，再测试和构建。已经上传过商店的版本不能用新内容覆盖。

商店 ZIP 根目录必须是 manifest.json 及扩展文件，不能混入 Node 服务、开发者配置或个人数据。使用已有商店条目更新，保持 ID `aemncphfnlpbhlddifhohpgegejjejfm`。

文案、隐私页、审核记录在 [store](../store/REVIEW.md)。v0.3.1 已于 2026-10-19 在公开商店确认上架；v0.3.2 同日先发布配套服务，再提交已有商店条目审核，设置为通过后自动发布。v0.3.2 标签固定在 `f4356a2`，发行附件不覆盖已发布版本；后续文档状态更新不改变该安装包。

更新支持站点时只发布静态页面；确认公开隐私 URL 和发行下载链接可用。不要把静态 ZIP、本地构建或商店草稿状态当成已经上架。

新版本发布顺序：先完成所有测试，发布同版本 companion 服务包，运行 `npm run check:release-links` 验证公开下载及隐私 URL；通过后再提交 Chrome 扩展。扩展连接页按自身版本生成服务包链接，不允许商店已更新而配套包仍是 404。支持站点与旧版兼容指南可独立更新，不冒充扩展运行时更新。

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

macOS 服务管理：`npm run service -- status`、`restart`、`logs`、`uninstall`。移动项目或 Node 路径后重新安装常驻服务。

`npm run pair -- --revoke <扩展ID>` 会立即撤销对应扩展授权；不需要重启服务。诊断日志与反馈中不得包含配对码、API key 或笔记内容。

更多架构背景见 [DESIGN.md](../DESIGN.md)。

## README 产品截图

首页使用真实扩展界面，不在 HTML 中仿制功能面板。原创样文位于 `assets/readme/reading-article.html`，截图脚本会创建临时扩展与浏览器配置，实际输入批注，验证侧栏镜像和 Markdown 导出，然后生成 `assets/readme/inline-annotation.png`。

```bash
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime node tools/capture-readme.mjs
```

该运行目录需已安装 Playwright 与支持扩展的 Chromium；也可通过 `CONTEXTFLOW_CHROMIUM_PATH` 指定浏览器。截图不读取个人浏览器资料、不需要模型或本地服务。更新画面时同步核对 README 的版本说明。
