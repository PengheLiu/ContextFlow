# ContextFlow 本地配套服务

此发行包用于连接 ContextFlow Chrome 扩展。高亮、批注和 Markdown 导出不需要运行此服务；AI、笔记同步和本地 agent 需要。

## 安装与连接

1. 安装 Node.js 22.5 或更新版本，将此 ZIP 解压到一个固定目录。
2. 在解压后的目录打开终端，运行：

   ```bash
   npm ci --omit=dev
   npm run server
   ```

3. 保持终端运行。服务默认只监听本机 `127.0.0.1:7317`，不需要开放公网端口。
4. 打开扩展的“扩展程序选项”连接页，复制页面显示的配对命令，在解压目录的另一个终端运行。不要直接复制下面的占位 ID：

   ```bash
   npm run pair -- <扩展ID>
   ```

5. 把生成的配对码粘贴回扩展页面，阅读数据使用说明并验证连接。不要把配对码发给维护者或放进公开反馈。
6. 在网页阅读面板中配置笔记目录。先选择不含私人数据的测试目录；需要 AI 时，再填写你自己的模型配置或选择本地 agent。

此包保留锁定依赖信息，但不携带 `node_modules`、个人配置、笔记、API key 或配对凭证。安装需要访问 npm 包仓库。模型服务可能产生额外费用，不包含免费额度。

## 停止与撤销

- 前台运行时按 `Ctrl+C` 停止服务。
- 撤销某个扩展的访问权限：`npm run pair -- --revoke <扩展ID>`，无需重启服务。
- 重新生成配对码会让旧码失效；仅在扩展页面清除配对码不会撤销服务端授权。
- 默认数据目录为 `~/.contextflow`；如设置过 `CONTEXTFLOW_DIR`，以自定义路径为准。停止服务或卸载扩展不会自动删除本地服务数据、已同步笔记或第三方服务的留存副本。

## macOS 可选常驻服务

先停止前台服务，再在固定的解压目录执行 `npm run service`。不要移动该目录；移动后需重新安装常驻服务。

```bash
npm run service -- status
npm run service -- restart
npm run service -- logs
npm run service -- uninstall
```

其他系统先使用前台运行方式，不承诺自动安装。

## 反馈与隐私

隐私政策见本包的 `privacy.html`。源码和问题反馈入口为 ContextFlow GitHub 项目：`https://github.com/PengheLiu/ContextFlow`。反馈前请脱敏，不上传真实笔记、完整配置、API key 或配对码。
