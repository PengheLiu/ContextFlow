# 支持页面与本地服务发布

## 当前边界

本地构建产物不等于已部署。未验证真实 HTTPS 地址之前，不把预想的 URL 填入 Chrome Web Store；也不把尚无新配对功能的 GitHub 默认分支作为当前扩展的安装版本。

## 构建与检查

```bash
npm run test:store-support
npm run build:store-support
cd release
shasum -a 256 -c contextflow-store-site-0.3.0.zip.sha256
shasum -a 256 -c contextflow-companion-0.3.0.zip.sha256
```

版本号由 `package.json` 决定。测试会在临时目录解压服务包并安装生产依赖，使用独立数据目录和随机端口验证配对与撤销，不重启用户的 7317 服务，也不调用真实模型。

## 静态站点

`contextflow-store-site-<版本>.zip` 根目录只包含：

- `index.html`：产品支持入口及使用前说明。
- `privacy.html`：完整隐私政策。
- `demo.html`：不含真实个人数据的阅读示例。

将 ZIP 解压内容交给已授权的静态 HTTPS 托管服务即可；不需要 Node.js、数据库、服务端密钥或登录。不要部署整个仓库、`release/` 或个人配置目录。

部署后验收：

1. 使用未登录环境打开首页及 `privacy.html`，确认返回 HTML 内容而不是源码下载、登录页或 404。
2. 核对隐私政策标题和更新日期，并检查所有站内链接。
3. 在桌面和窄屏查看，确认文字、按钮可读。
4. 用实际站点的 `privacy.html` HTTPS 地址填写商店“隐私政策”字段，首页作为支持说明入口。

已启用 GitHub Pages，来源为 `gh-pages` 分支根目录，只发布上述三个静态页面。首页为 https://pengheliu.github.io/ContextFlow/ ，隐私政策为 https://pengheliu.github.io/ContextFlow/privacy.html 。更新时只同步这三个文件，并检查 Pages 构建完成及公开 URL，不部署整个工作区。

## 配套服务

`contextflow-companion-<版本>.zip` 是用于扩展连接的最小运行包：包括服务源码、三个共享模块、配对与 macOS 常驻工具、依赖锁文件、隐私政策及独立安装说明。仅保留 `server`、`pair`、`service` 命令，不包含开发者本机凭证、浏览器构建产物或笔记。

0.3.1 安装包及校验文件已发布至 https://github.com/PengheLiu/ContextFlow/releases/tag/v0.3.1 。新版本仍需上传对应 ZIP 与 `.sha256`，并同步真实下载链接。当前源码的 0.3.2 尚未发行，不能将 0.3.1 下载链接描述为已包含新欢迎页。

安装说明已放入服务 ZIP 的 `README.md`，源文件为 `store/COMPANION.md`。依赖安装使用 `npm ci --omit=dev`；扩展 ID 从用户实际安装后的连接页获取。

此服务包的验证不代替真实 AI 及完整笔记同步测试；不要因此宣称这些功能已完成审核验收。
