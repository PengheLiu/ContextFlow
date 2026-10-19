# 审核与发布准备

## 最新状态：2026-10-19

- **0.3.2 已提交 Chrome Web Store 审核**，后台确认“已将您的扩展程序提交送审”及“待审核”；刷新状态页复核。保留审核通过后自动发布。这不是已获批或已上架。
- 继续使用正式条目 `aemncphfnlpbhlddifhohpgegejjejfm`，不新建条目、不撤回旧版；免费、公开、所有地区设置保持不变。公开安装入口：https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm 。
- 先公开 [GitHub v0.3.2](https://github.com/PengheLiu/ContextFlow/releases/tag/v0.3.2) 的三个 ZIP 及各自 SHA-256，再上传扩展。标签对应源码 `f4356a2e1b758a31e6ef7dbd111ddff47c78607a`。`npm run check:release-links` 已通过，并实际下载公开 companion 核验内容校验和。
- 已上传并在后台文件包页核对：草稿 0.3.2、已发布 0.3.1；扩展 ZIP SHA-256：`739159e51deb7c4745d4c934abf49603b36d22198cbf44443438518d1875441c`；companion ZIP：`a6060339e1d82f34bf8fcf14d03871772df1c7899a4c0508907fe003e47463cb`。
- 商店说明已改为先离线批注、按需连接 AI/同步，并更正 Node.js 最低版本为 22.13+；保存后刷新核对。测试说明已换成 499 字的实际 0.3.2 步骤，含公开下载地址、同页配置、离线验证和撤销命令；清除了原先误放在用户名字段的说明及旧占位文字，用户名和密码均留空，因为产品无需账号。保存后刷新复核。
- 隐私政策 URL、身份验证信息/网络记录/网站内容申报、三项用途承诺及无远程代码声明均核对，不增加权限或遥测。未提交生产密钥、配对码或私人笔记。
- 提交前完整自动化测试、独立服务包安装/配对测试和正式商店 ID 的隔离 Chromium 端到端测试通过。模型使用隔离测试端点，未调用真实计费服务；Windows/Linux 尚未完成全新真实机器验收。
- README、安装指南与支持首页按“0.3.1 已上架 / 0.3.2 待审核”更新；GitHub 发行包是提交前固定快照，公开支持站点随后独立部署状态更新，不覆盖发行附件。
- 官网升级为产品站，保持原地址 https://pengheliu.github.io/ContextFlow/ ，独立部署提交为 `8e1b525ce0217d3dab248cbfad6989a9394e60a6`。新增真实产品截图、功能与配置说明、安装路径、原生可键盘操作的 FAQ、SEO 与移动端样式；站点无统计脚本、第三方字体或登录功能。GitHub 仓库 About Website、中英文 README 与安装指南已补官网入口。
- 官网入口维护待办：后台首页网址目前为 GitHub 仓库，0.3.2 待审核期间输入框、保存和提交均禁用。本次只读确认，没有为修改 URL 撤回审核；待可编辑时更新为官网。支持网址和隐私政策地址不变。

## 首次上架核对：2026-10-19

- 已通过公开 Chrome 应用商店页面核对：ContextFlow 版本 **0.3.1** 已上架，更新日期为 2026-10-19。正式入口：https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm 。
- 源码 0.3.2 包含首次安装、目录校验、单终端配对启动、同页配置、连接恢复和笔记同步衔接修复，尚未提交商店。不得把本地构建称为已上架。
- 0.3.2 提交前须先公开同版本 companion 下载包，再上传扩展并更新支持站点；连接页生成与自身版本一致的服务包链接。旧 0.3.1 安装包不可覆盖。
- 以下是历史记录，审核待办与草稿状态只代表当时状态。

## 历史提交记录：2026-10-17

- 已整合 GitHub main 的 Markdown 表格预览、顶部重新解释与 agent 错误处理修复，发布版本为 **0.3.1**。
- 源码已推送到 main，发行包：https://github.com/PengheLiu/ContextFlow/releases/tag/v0.3.1 。扩展、配套服务和静态站点 ZIP 均附 SHA-256。
- 隐私政策已部署到 https://pengheliu.github.io/ContextFlow/privacy.html ，无需登录即可访问；支持首页及阅读示例同站点可用。
- 在已有条目 `aemncphfnlpbhlddifhohpgegejjejfm` 上传新版后，后台文件包已确认版本 **0.3.1**。
- 已保存公开隐私政策 URL、三项数据使用承诺和包含真实下载地址的 473 字测试说明；数据类别为身份验证信息、网络记录和网站内容，无远程代码。
- 提交前后台显示免费、公开分发，全部地区保持原有设置。已启用“审核通过后自动发布”。
- **已提交 Chrome Web Store 审核**，Google 明确显示“待审核”及“您的内容已提交，目前正在接受合规性审核”。这不代表已获批或已上架。
- 提交流程提示全站权限可能需要深入审核；未改动跨站恢复高亮所需的权限。
- 完整测试套件、商店专项检查、配套服务全新依赖安装及 Chromium 153.0.8010.12 端到端测试通过；覆盖正式商店 ID、独立配对、私有存储、刷新恢复、凭证隔离、实时撤销、离线高亮和 Markdown 导出。未调用真实计费模型。
- 发布记录不会包含配对码、API key、实名资料或账号私密信息。以下为 2026-10-12 的历史准备记录，当前状态以上述为准。

## 历史准备记录：2026-10-12

- 已有无发布者凭证的商店打包命令：`npm run build:store`。
- 已有运行时独立配对、实时撤销和扩展私有缓存。
- 已有首次安装连接页、隐私页面及商店中文说明草稿。
- 原有测试、商店专项测试和独立 Chromium 153.0.8010.12 的浏览器测试已通过：包含实际配对、私有存储、刷新恢复、凭证访问隔离、撤销，以及停止服务后的离线新增和 Markdown 导出。
- 已生成并目视检查 `release/store-assets/reading-1280x800.png` 与 `release/store-assets/promo-440x280.png`。
- 2026-10-12，用户已自行提交交易者认证；刷新开发者后台后显示“您的验证正在等待处理”。未重复提交或修改实名资料，实名资料不写入本仓库。
- 用户已完成两步验证；2026-10-12 重试上传 `contextflow-chrome-0.3.0.zip` 成功。后台文件包显示版本 `0.3.0`、状态“草稿”，正式扩展 ID 为 `aemncphfnlpbhlddifhohpgegejjejfm`。未提交审核、未发布。
- 已保存并刷新复核中文说明、类别“工具”、语言“中文（中国）”、GitHub 首页及问题反馈地址、128×128 图标、1280×800 实际截图和 440×280 小宣传图。
- 已保存单一用途、storage 和主机权限理由、无远程代码声明，以及“身份验证信息 / 网络记录 / 网站内容”三类数据申报草稿。公开隐私政策地址尚空缺；三项政策承诺在最终核对前保留未选中。
- 分发设为“免费、不公开（知道链接的用户可见）”，并刷新确认保存；地区暂保留后台默认值，提交前还需确认。已保存 397 字测试说明，配套服务下载地址和完整指引仍待补齐。
- 后台“我为何无法提交？”目前列出：联系邮箱未填写及验证、缺少隐私政策链接、尚未确认数据使用政策承诺。刷新账号设置后，交易者认证仍显示“您的验证正在等待处理”。
- 已核对公开 GitHub 默认分支：尚无 `server/extension-pairing.mjs`，也未启用 Pages，不能让用户直接使用旧版本来连接新扩展。
- 新增 `npm run build:store-support`：生成仅含静态支持页面的部署 ZIP，以及含独立配对功能的本地配套服务 ZIP，均附 SHA-256。它们仍是本地产物，尚未公开部署；没有提交扩展审核或公开发布。
- `npm test` 再次通过；`npm run test:store-support` 验证了解压后的服务包全新安装生产依赖、实际启动、独立配对和实时撤销。静态支持首页已在浏览器目视检查，隐私链接可访问；三个发行 ZIP 的校验和均验证通过。
- 已从后台读取并保存商店公钥 `store/extension-key.pub`，不修改个人开发版的公钥。以该公钥加载隔离测试副本，浏览器实际 ID 与正式商店 ID 一致；配对、凭证隔离、撤销、离线恢复和 Markdown 导出的真实浏览器测试全部通过。测试仅在临时副本更换本地服务端口并注入公钥，已上传的商店 ZIP 未改动。

## 后台入口

- 草稿详情：<https://chrome.google.com/webstore/devconsole/54ca0f6b-9de1-48e1-9df1-dbe29949b67d/aemncphfnlpbhlddifhohpgegejjejfm/edit/listing>
- 扩展 ID：`aemncphfnlpbhlddifhohpgegejjejfm`。
- 已接收文件：`release/contextflow-chrome-0.3.0.zip`，SHA-256 为 `53b12d77eba97f1840cbe7472970e3133af4892237aa3f1afe27b8d29bcc99bd`。
- 该条目尚未发布，后台入口不是用户安装链接。

## 提供给审核者的测试说明草稿

ContextFlow 是本地优先的网页阅读批注扩展。离线高亮、批注和 Markdown 导出可以直接验证；AI、agent 及笔记同步需要用户自己的本地服务，扩展不提供托管模型账号。

1. 安装扩展，打开普通网页或配套的 `store/demo.html` 示例页面。不要在 Chrome 内部页面或商店页面验证内容脚本。
2. 选中一段正文，点击高亮或批注。打开阅读侧栏，确认保存结果，刷新后确认恢复；点击“下载”导出 Markdown。
3. 在提供的对应版本项目目录运行 `npm ci`，然后运行 `npm run server`，保持此终端运行。服务只监听本机地址。
4. 打开扩展自己的连接页，复制其中的 `npm run pair -- <实际扩展ID>`，在另一个终端执行。
5. 将生成的配对码粘贴回扩展页面，阅读数据说明，验证连接。配对码为本机独立凭证，不是生产密钥或测试账号密码。
6. 在网页侧栏配置笔记输出目录，先用不含敏感数据的测试目录验证同步；不要指向真实个人笔记。
7. 如测试 AI，配置审核者可用的模型服务，或由维护者通过私密审核字段提供有限权限、可撤销的专用测试额度。不要把生产 API key 写入公开材料。
8. 如测试 agent，先使用默认安全配置和样例笔记目录；完整权限是需要额外确认的高级能力。
9. 停止本地服务后验证离线标注与导出。恢复服务后再验证待同步记录。
10. 执行 `npm run pair -- --revoke <扩展ID>`，确认旧配对码不再可用。

## 提交前的剩余事项

- 确认公开联系邮箱并完成验证、发行地区和首批测试用户；交易者身份认证继续等待 Google 处理。
- 发布当前代码对应的本地服务安装版本；当前 GitHub 默认分支是否已包含这些改动，不能仅凭本地工作区推断。
- 将静态站点部署包发布到公开 HTTPS URL，并用未登录浏览器验证 `privacy.html`；具体操作见 `store/DEPLOY.md`。
- 将实际服务下载链接和完整测试指引补进后台测试说明，最终核对数据申报与三项政策承诺。
- 新版本继续使用已有草稿，不能重复创建条目。草稿创建不等于提交审核或公开发布。
- 如上传过相同版本号，必须先递增 `package.json` 的版本后重新打包。
- 实际 AI 服务及完整笔记同步用例需要指定测试环境；纯离线或模拟测试不能算作这些功能的完成验证。

## 自动化检查

```bash
npm test
npm run build:store
npm run test:store-support
npm run build:store-support
```

可选的真实浏览器测试使用独立安装的 Playwright 与 Chromium，不读取用户的浏览器资料，也不重启用户原有的 7317 服务。测试会在临时目录构建一个只更换本地服务端口的副本：

```bash
CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/test-runtime \
CONTEXTFLOW_CHROMIUM_PATH=/path/to/chromium \
CONTEXTFLOW_STORE_PUBLIC_KEY_FILE=store/extension-key.pub \
CONTEXTFLOW_EXPECTED_EXTENSION_ID=aemncphfnlpbhlddifhohpgegejjejfm \
node test/store-browser.test.mjs
```

`/path/to/test-runtime` 应已安装 `playwright`；也可省略浏览器路径，使用该运行时安装的 Chromium。测试截图写入 `release/store-assets/`，失败截图不能作为商店宣传材料。
