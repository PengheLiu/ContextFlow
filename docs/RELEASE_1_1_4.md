# ContextFlow 1.1.4

- 支持在 macOS 上用 DeepSeek Harness `0.2.2-rc.2` 运行网页解释和文章速览，包括流式回答、续问与取消。
- 适配新版 DeepSeek Harness 的官方账号连接测试，保留 API Key 连接测试。
- 设置页分别显示模型连接和网页回答的兼容性。检测到尚未适配的 DSH 桌面版时，会提示更新 ContextFlow 或改用 LLM。

如果 DSH 更新后出现「测试通过，但网页无法回答」，请从 [官网下载页](https://pengheliu.github.io/ContextFlow/download.html) 下载桌面端。先退出旧版，再覆盖安装，重新打开网页后重试。保留原有配置、阅读记录与浏览器授权。扩展由 [Chrome 商店](https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm) 分发。

本次桌面安装包适用于 Apple Silicon Mac，要求 macOS 13.5 或更高版本。安装包未使用 Developer ID 签名、未通过 Apple 公证。终端用户可使用配套服务 ZIP，基础阅读功能可直接使用 Chrome 扩展。
