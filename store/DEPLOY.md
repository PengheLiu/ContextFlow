# 支持页面与本地服务发布

## 当前边界

本地构建产物不等于已部署。未验证真实 HTTPS 地址之前，不把预想的 URL 填入 Chrome Web Store；也不把尚无新配对功能的 GitHub 默认分支作为当前扩展的安装版本。

## 构建与检查

```bash
npm run test:store-support
npm run build:store-support
cd release
shasum -a 256 -c contextflow-store-site-<版本>.zip.sha256
shasum -a 256 -c contextflow-companion-<版本>.zip.sha256
```

版本号由 `package.json` 决定。测试会在临时目录解压服务包并安装生产依赖，使用独立数据目录和随机端口验证配对与撤销，不重启用户的 7317 服务，也不调用真实模型。

## 静态站点

正式官网：https://pengheliu.github.io/ContextFlow/ 。GitHub 仓库 About 的 Website 与中英文 README 均应指向此地址，而不是开发者后台。

官网源码为 `store/index.html` 与 `store/site.css`。使用真实产品截图，功能示意明确标注；无需构建框架、第三方字体、遥测或后端。构建和本地预览：

```bash
npm run test:website
npm run build:website
python3 -m http.server 7339 --bind 127.0.0.1 --directory release/website
```

打开终端输出的本地 URL。`release/website` 是部署目录，不包含服务端或扩展运行文件。`tools/build-website.mjs` 导出唯一的发布白名单，预览、打包和发布使用同一套文件映射：

- `index.html`：产品官网、真实截图、功能介绍、安装路径与 FAQ。
- `site.css`：官网桌面与窄屏样式。
- `privacy.html`：完整隐私政策。
- `demo.html`：不含真实个人数据的阅读示例。
- `assets/mark.svg`、`assets/inline-annotation.png`、`assets/reading-library.png`：品牌标记与 1.0 真实产品截图，从仓库资产目录复制，不依赖远程图床。

有仓库写权限并已登录 GitHub CLI 的维护者，在测试与浏览器检查通过后执行：

```bash
npm run deploy:website
npm run deploy:website -- --publish
gh api repos/PengheLiu/ContextFlow/pages/builds/latest
```

第一条仅展示发布范围。第二条会把白名单文件原子提交到现有 `gh-pages`，保留其他文件并禁止强推；它不修改已发布 Release 附件或正在审核的扩展。GitHub 接收提交后还需等待 Pages 构建完成，再访问实际网址确认。

将 ZIP 解压内容交给已授权的静态 HTTPS 托管服务即可；不需要 Node.js、数据库、服务端密钥或登录。不要部署整个仓库、`release/` 或个人配置目录。

部署后验收：

1. 使用未登录环境打开首页及 `privacy.html`，确认返回 HTML 内容而不是源码下载、登录页或 404。
2. 核对隐私政策标题和更新日期，并检查所有站内链接。
3. 在桌面和窄屏查看，确认文字、按钮可读。
4. 用实际站点的 `privacy.html` HTTPS 地址填写商店“隐私政策”字段，首页作为支持说明入口。

已启用 GitHub Pages，来源为 `gh-pages` 分支根目录。按上述白名单同步，保留已有无关文件，不强推分支；检查 Pages 构建完成、公开 URL 及图片/CSS 返回 200。隐私政策地址保持 https://pengheliu.github.io/ContextFlow/privacy.html ，练习文章地址保持 `/ContextFlow/demo.html`。不要部署整个工作区，不覆盖已发布 Release 附件。

Chrome 商店「首页网址」应指向正式官网；「支持网址」保留 GitHub Issues，「隐私政策」保持原 URL。若当前版本正在审核，不为修改官网链接取消审核，待可编辑时再更新商店字段。「官方网址」的所有权验证字段与普通「首页网址」不是同一个字段，不冒用未经验证的域名。

## 配套服务

`contextflow-companion-<版本>.zip` 是用于扩展连接的最小运行包：包括服务源码、三个共享模块、配对与 macOS 常驻工具、依赖锁文件、隐私政策及独立安装说明。仅保留 `server`、`pair`、`service` 命令，不包含开发者本机凭证、浏览器构建产物或笔记。

0.3.1 与 0.3.2 安装包及校验文件均已发布至 GitHub Releases；0.3.2 标签固定对应首次连接改进代码。新版本仍需先上传对应 ZIP 与 `.sha256`，再提交扩展审核。官网是独立静态发布，不通过重复上传扩展或覆盖旧 ZIP 更新。

安装说明已放入服务 ZIP 的 `README.md`，源文件为 `store/COMPANION.md`。依赖安装使用 `npm ci --omit=dev`；扩展 ID 从用户实际安装后的连接页获取。

此服务包的验证不代替真实 AI 及完整笔记同步测试；不要因此宣称这些功能已完成审核验收。
