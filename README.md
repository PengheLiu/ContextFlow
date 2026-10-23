<div align="center">

<img src="./assets/mark.svg" alt="" width="64" height="64">

<h1>ContextFlow</h1>

<h3>把阅读，变成可复用的上下文。</h3>

<p>在原文旁思考，用 AI 深入理解，让阅读回到自己的知识系统。</p>

<p>
  <a href="https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm"><strong>从 Chrome 商店安装</strong></a>
  · <a href="https://pengheliu.github.io/ContextFlow/">产品官网</a>
  · <a href="https://pengheliu.github.io/ContextFlow/download.html">桌面端</a>
  · <a href="./docs/GETTING_STARTED.md">开始使用</a>
  · <a href="./README.en.md">English</a>
</p>

<p><sub>开源 · 本地优先 · Markdown · Obsidian · 思源</sub></p>

</div>

> **扩展负责阅读，桌面端连接工具。** 从一条批注开始，需要 AI 和笔记同步时，再连接自己的模型与笔记库。桌面安装和连接不需要终端。

ContextFlow 是为深度阅读打造的浏览器阅读工作台。读论文、技术文章或研究报告时，把**原文、疑问和自己的判断**留在一起，再将它们整理进自己的笔记，而不是散落在收藏夹、聊天窗口和临时文档里。

<img src="./assets/readme/inline-annotation.png" alt="真实操作界面：选中网页原文后就地写批注，同一条批注同时出现在右侧阅读记录中" width="100%">

<sub>实际操作界面：原文旁直接写，侧栏同步收录。截图使用原创样文与示例批注，不含私人阅读数据。</sub>

## 不只保存文章，也保留你为什么读它

### 思考，不必离开原文

选中一段话，就能在原文旁高亮、写批注、粘贴截图。无需先切到侧栏寻找输入框，也不用把一句话搬到另一个工具里才能记录想法。

原位面板与侧栏编辑的是**同一条记录**：就地捕捉想法，在侧栏集中回看；点击记录，可以定位回原文。重新打开文章时，已保存的标记会尝试恢复。

### 有疑问，就沿着上下文追问

对选中内容进行解释或翻译，在当前页面继续追问；长文可以先看速览，再回到具体段落深入理解。AI 结果和自己的补充一起留在阅读记录中，也可以在补充里粘贴图片。

你选择模型与本地 Agent，ContextFlow 负责把问题带到阅读现场。AI 能力需要连接配套服务，不影响基础批注和导出的独立使用。

### 读完之后，回到自己的笔记

把速览、批注、解释、翻译和自己的总结整理为带来源的 Markdown，直接复制或下载；连接本地服务后，也能同步到 **Obsidian、Markdown 目录或思源笔记**。

同一篇文章持续更新同一份笔记，减少反复整理。浏览器内输入自动保存；写入笔记软件由你点击「同步」触发。笔记保留为你能够管理、迁移和继续编辑的内容。

## 让过去的理解，参与此刻的阅读

笔记不必只成为阅读的终点，也可以成为下一次理解的起点。

为支持相应读取模式的本地 Agent 授权指定笔记目录后，可以让它参考你的积累，围绕当前文章继续提问：

- **对照旧观点：** 这个结论，与我之前的理解有什么不同？
- **寻找关联：** 哪些笔记讨论过相同的问题？
- **继续研究：** 新材料是否回答了我以前留下的疑问？

这是 ContextFlow 连接网页、AI 与个人知识库的方式，而不是另建一个封闭的收藏库。实际检索与回答取决于你配置的 Agent、授权范围和笔记内容，重要结论仍需核对原文。笔记写入目的地和 Agent 读取目录分别设置；选中一个 Vault 不会自动授权 Agent 读取。[了解产品理念 →](./docs/PRODUCT.md)

## 开始使用

**先完成一次有价值的阅读，不必先配置 AI。** 高亮、批注、粘贴图片和 Markdown 导出，只需扩展，不需要账号、API key 或本地服务。

1. **安装扩展。** 在 [Chrome 应用商店](https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm)点击「添加至 Chrome」，无需下载 ZIP 或开启开发者模式。
2. **留下想法。** 刷新一篇文章，选中一句正文，点击「批注」。可以从[阅读练习页](https://pengheliu.github.io/ContextFlow/demo.html)开始。
3. **把记录带走。** 打开右侧阅读记录，在底部点击「下载」，得到带原文、批注与来源的 Markdown。

[查看完整安装指南与常见问题 →](./docs/GETTING_STARTED.md)

### 需要 AI 或笔记同步时，再连接桌面端

[官网下载页](https://pengheliu.github.io/ContextFlow/download.html)提供 Mac Apple Silicon 桌面端 1.1.0 的 DMG 与 SHA-256 校验文件，要求 macOS 13.5+。桌面端内置本地运行环境，最终用户不需要安装 Node.js、Git 或运行 npm。Mac Intel 和 Windows 暂未开放安装包下载，不要随机选择其他架构。

桌面一键连接需要 **ContextFlow Chrome 扩展 1.1.0 或更高版本**。下载前请在扩展「连接与设置」确认有「连接桌面端」入口；商店可安装版本以实际页面为准。没有入口时，可先继续高亮、批注与 Markdown 导出，不要卸载扩展。

安装并打开桌面端，自动准备本地连接 → 回扩展「连接与设置」点击「连接桌面端」→ 在桌面弹窗核对申请、点击「允许连接」→ 按需选择模型或 Agent，测试后「保存更改」→ 选择笔记目的地、保存并「确认使用这个位置」→ 回文章完成一次回答或点「同步」。不需要终端或手动生成、复制配对码；各 Chrome 配置分别授权，可独立撤销。AI 与笔记同步可独立跳过；只同步笔记无需配置模型。

自动发现只展示候选，不代表登录、授权读取或可用；连接测试需要主动触发，可能使用模型额度，也不能代替真实回答和文件写入。确认保存位置不会自动同步。

连接前按 Chrome 提示核对所需权限，更新后刷新已打开的文章。[版本与连接要求 →](./docs/GETTING_STARTED.md#版本与连接要求)

**安装安全与范围：** 当前 Mac 包未经 Developer ID 签名和 Apple 公证，SHA-256 不能代替系统安全验证。若 macOS 拦截，请先核对官方来源并阅读 [Apple 安全说明](https://support.apple.com/zh-cn/102445)，不要关闭 Gatekeeper 或运行批量移除隔离标记的命令。当前验证范围为 Apple Silicon 本机与隔离测试，不代表所有 Mac 均已验收。其他环境可继续基础阅读，或明确选择[高级兼容路径](./docs/GETTING_STARTED.md#高级兼容路径命令行服务)。[桌面能力与验证范围 →](./docs/DESKTOP.md)

## 找得回，也带得走

在侧栏打开「我的阅读库」，按原文、问题或笔记跨文章检索，筛选解释、翻译和批注，不必记得当时在哪个网站读过。

<img src="./assets/readme/reading-library.png" alt="阅读库：跨文章搜索、记录预览、Markdown 下载与完整备份" width="100%">

- 长回答按需展开，重新生成会保留旧答案与最近五个历史版本；取消、删除撤销和失败重试都有明确反馈。
- 单篇下载带图片的 Markdown；完整 JSON 备份可在重新安装后补充恢复，不覆盖已有内容，不自动重启 AI。
- 「帮助与诊断」集中检查连接、版本和存储，可预览并复制脱敏报告，不上传文章或密钥。

完整备份限 32 MB，内容可读且未加密，请妥善保存。它是浏览器阅读记录的备份，不包含配置、密钥或外部笔记；桌面端的本机恢复点不能替代它。卸载扩展会清除浏览器内记录，建议定期备份。[能力范围与已知限制 →](./docs/RELEASE_1_0.md)

基础阅读支持桌面 Chrome / Chromium 111+ 的普通网页。Chrome 内部页面、扩展商店、内置 PDF 阅读器和本地文件暂不支持。桌面连接按 Google Chrome 验证，其他 Chromium 浏览器未作同等承诺；桌面内置运行时要求 macOS 13.5+，各系统、架构与 Agent 仍需[分别验证](./docs/DESKTOP.md#当前发布状态)。这不改变扩展独立使用的浏览器范围。当前界面主要为中文。

### 按你的工作方式，开启更多能力

| 能力 | 需要准备 |
| --- | --- |
| 高亮、原位批注、图片补充、Markdown 导出 | 仅安装扩展 |
| 同步到 Obsidian / Markdown / 思源 | 桌面端连接 + 保存位置，无需配置 AI |
| AI 速览、解释、追问 | 桌面端连接 + 自己的 LLM 或本地 Agent 配置 |
| 翻译 | 桌面端连接 + LLM 配置（不能仅配置 Agent） |
| 参考个人笔记回答问题 | 支持相应读取模式的本地 Agent + 独立授权的笔记目录 |

桌面端的服务自动准备；只有高级命令行路径需要 Node.js 22.13+。模型费用由你使用的服务决定，ContextFlow 不提供内置模型额度。[连接与使用说明 →](./docs/GETTING_STARTED.md#开启-ai-和笔记同步)

## 数据在你的工具里，权限由你决定

- **本地优先，不设阅读云账号。** 浏览器记录保存在扩展私有存储；连接后也会保存到本机配套服务。写入外部目录或笔记软件由「同步」触发，不等于浏览器自动保存。
- **AI 去向取决于你的配置。** 文章、问题及授权笔记内容可能发送到所选模型或 Agent 服务。本地优先不等于所有 AI 都离线运行。
- **个人笔记按范围授权。** 新配置默认选用 Safe，隔离边界取决于 Agent 及版本；不支持 Safe 的工具不能据此宣称受限可用。Full 完整权限需显式确认，不应只为通过测试而开启。不要公开配对码、API key 或私人笔记。

请定期导出或同步备份。卸载扩展会清除浏览器内记录，不会删除已导出的文件或已同步笔记；网页结构变化也可能影响原文标记恢复。

[隐私政策](https://pengheliu.github.io/ContextFlow/privacy.html) · [数据保存与升级说明](./docs/GETTING_STARTED.md#日常运行与升级)

## 反馈与参与

遇到问题或有使用建议，欢迎[提交 Issue](https://github.com/PengheLiu/ContextFlow/issues)。请附上扩展版本、浏览器版本、复现步骤和脱敏截图。

[发行记录](https://github.com/PengheLiu/ContextFlow/releases) · [桌面 v1.1.0](https://github.com/PengheLiu/ContextFlow/releases/tag/v1.1.0) · [开发指南](./docs/DEVELOPMENT.md) · [架构与安全设计](./DESIGN.md) · [MIT License](./LICENSE)
