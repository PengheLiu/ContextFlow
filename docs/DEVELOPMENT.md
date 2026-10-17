# 开发与发布

普通用户请先看[安装与使用指南](./GETTING_STARTED.md)。这里面向修改源码、运行测试或维护发行包的开发者。

## 从源码运行

需要 Node.js 22.5+ 和桌面 Chromium 111+。

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

文案、隐私页、审核记录在 [store](../store/REVIEW.md)。v0.3.1 已提交审核并设置通过后自动公开发布。当前源码中的新手体验改进应随后续版本发布；不要为了同步文档就取消正在进行的审核。

更新支持站点时只发布静态页面；确认公开隐私 URL 和发行下载链接可用。不要把静态 ZIP、本地构建或商店草稿状态当成已经上架。

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
