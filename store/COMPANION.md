# ContextFlow 本地配套服务

这是熟悉终端用户的高级兼容包，不是桌面客户端，也不是普通用户桌面安装流程。商店已公开 1.0.0 的固定说明见 [1.0 安装指南](https://github.com/PengheLiu/ContextFlow/blob/v1.0.0/docs/GETTING_STARTED.md)。当前源码生成的配套包版本为 **1.1.1**；请使用与实际扩展匹配的已公开版本，公开下载以发行页为准。桌面安装包的状态统一见 [官网下载页](https://pengheliu.github.io/ContextFlow/download.html)。

如果已改由桌面端管理服务并加密保存配置，请继续从桌面端启动，不要另外执行本包或恢复旧登录项；没有桌面密钥的 CLI 不能解密该配置。回退前先备份并按迁移说明核对，不删除配置或重新生成配对码。

本包负责 AI、笔记同步和本地 agent，不是加载进 Chrome 的扩展。基础批注与 Markdown 导出无需运行本服务。

[完整安装与排障](https://github.com/PengheLiu/ContextFlow/blob/main/docs/GETTING_STARTED.md) · [Chrome 商店](https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm)

## 首次连接

1. 安装 Node.js 22.13+，重新打开终端，把本包解压到固定位置。
2. 进入有 `package.json`、`server` 和 `tools` 的服务文件夹。macOS：输入 `cd` 后敲空格，把文件夹拖进终端并回车；Windows：在此文件夹的资源管理器地址栏输入 `cmd`；Linux：在文件夹中打开终端。不要在主目录 `~` 或其他项目运行安装。
3. 打开 ContextFlow 的「扩展程序选项」，复制完整启动命令。它先校验目录与 Node.js，再安装依赖、生成当前扩展的配对码并启动服务。保持终端打开，回扩展只粘贴 43 位配对码并验证。

正式商店版也可直接复制下面一整行。解压开发版 ID 不同，务必使用其连接页的命令。Windows 使用命令提示符，不使用旧版 PowerShell。

~~~bash
node -e "const[v,m]=process.versions.node.split('.').map(Number);if(v<22||(v===22&&m<13)){console.error('请安装 Node.js 22.13 或更高版本，再重新打开终端。');process.exit(1)}let p;try{p=require('./package.json')}catch{}if(p?.name==='contextflow'&&p?.scripts?.server==='node server/index.mjs'&&require('node:fs').existsSync('server/index.mjs')){console.log('目录确认：ContextFlow');process.exit(0)}console.error('目录不对：请先进入解压后的 ContextFlow 服务文件夹，再运行本命令。');process.exit(1)" && npm ci --omit=dev && npm run pair -- aemncphfnlpbhlddifhohpgegejjejfm && npm run server
~~~

看到「目录确认：ContextFlow」、单独一行配对码，以及服务监听 `127.0.0.1:7317`，才表示安装和启动完成。出错不会继续下一步；目录错误时不要换源或删其他项目文件。服务运行时不返回命令提示符是正常的，不需要开放公网端口。

配对码只用于本机服务，不是模型 API key。不要把配对码、完整终端输出或模型密钥发给维护者。

## 配置和第一次成功

- 新版扩展配对后可在同页配置；旧版在文章侧栏「配置」中设置。
- 笔记：选择 Markdown / Obsidian / 思源并保存，回到文章写一条批注，点击「同步」，核对实际文档。只同步笔记不需要 AI。
- AI：选择服务类型、地址、自己的密钥和模型，主动测试后点击「保存更改」，再解释一小段公开原文。1.0 的测试不会保存配置。翻译需要 LLM，解释和速览可选择 LLM 或本地 Agent。模型费用由服务提供方收取，本包不包含免费额度。
- 本地 agent：需要自行安装、登录和明确授权目录，先使用受限权限。

## 停止、再次启动和撤销

Ctrl+C 或关闭终端会停止服务，但不会清除配对、数据库或已同步笔记。下次进入相同目录执行：

~~~bash
node -e "const[v,m]=process.versions.node.split('.').map(Number);if(v<22||(v===22&&m<13)){console.error('请安装 Node.js 22.13 或更高版本，再重新打开终端。');process.exit(1)}let p;try{p=require('./package.json')}catch{}if(p?.name==='contextflow'&&p?.scripts?.server==='node server/index.mjs'&&require('node:fs').existsSync('server/index.mjs')){console.log('目录确认：ContextFlow');process.exit(0)}console.error('目录不对：请先进入解压后的 ContextFlow 服务文件夹，再运行本命令。');process.exit(1)" && npm run server
~~~

不用再次安装，也不要重复生成配对码。只有首次连接、切换扩展或旧码失效才使用 `npm run pair -- <实际扩展ID>`；重新生成会让旧码失效。

撤销扩展授权：`npm run pair -- --revoke <实际扩展ID>`，无需重启服务。仅清除浏览器里的配对码不等于撤销服务端授权。

## macOS 可选常驻服务

先 Ctrl+C 停止前台服务，再在固定目录执行 `npm run service`，以后登录会自动启动。不要移动这个目录，也不要与前台服务重复启动。

~~~bash
npm run service -- status
npm run service -- restart
npm run service -- logs
npm run service -- uninstall
~~~

Windows / Linux 暂使用前台运行方式，不承诺未经实机验证的自动常驻安装。

## 升级，不要重新配对

先确认当前扩展版本，下载匹配服务包并解压。停止旧服务，进入新服务文件夹执行目录检查与 `npm ci --omit=dev`，再启动。保留原有 `~/.contextflow` 或自定义 `CONTEXTFLOW_DIR`，不要覆盖配置 / 数据库，不要重新生成配对码。

macOS 常驻服务如果仍指向旧文件夹，在停止旧进程后从新文件夹执行 `npm run service` 更新路径；如果更新的是相同文件夹，执行 `npm run service -- restart`。不要与前台服务同时运行。扩展选项页可「检查本地服务连接」，1.0 的「帮助与诊断」可查看版本与脱敏计数。

## 数据与隐私

默认数据目录 `~/.contextflow`，设置过 `CONTEXTFLOW_DIR` 时以自定义位置为准。升级前备份；停止服务或卸载扩展不会自动删除本地数据库和已同步笔记。

本包不携带 node_modules、个人配置、笔记、API key 或配对凭证。安装需要访问 npm；AI 请求可能把文章、问题和授权笔记发送到你配置的服务。隐私政策见本包 `privacy.html`。反馈前脱敏，不上传密钥、配对码、完整配置或私人笔记。
