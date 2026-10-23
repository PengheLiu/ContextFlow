# 1.1.0 送审前验收记录

日期：2026-10-23 至 2026-10-24（北京时间）。本记录区分自动化、真实浏览器、原生系统和公开发布；测试通过不是“绝无 bug”的承诺。

## 本轮抓到并修复的问题

- 普通 HTTP 网页没有 `crypto.randomUUID`：批注可无反应。浏览器代码统一使用 CSPRNG UUID helper，在 HTTP 下用 `getRandomValues` 生成 RFC 4122 v4，不退回 `Math.random`；最终 ZIP 验收明确使用非安全 HTTP 环境。
- 原生连接过期后迟到允许会留下幽灵授权。新增 65 秒期限、断开取消与逐申请锁；同步确认申请仍有效后才写入授权，迟到批准不落盘。
- 单独撤销旧式授权不应清空同扩展的其他原生安装实例；新增范围回归，保留命令行整 ID 撤销语义。
- 匿名 Mac 包需要重新封装内容完整性，不能沿用 Electron 的残留签名。整包 `codesign --verify --deep --strict` 通过，但不冒充 Developer ID 签名或 Apple 公证。
- 官网独立安装包使用 direct 渠道，只允许正式商店扩展 ID；开发 ID 不进入官网下载包的原生白名单。

## 已通过的本地验收

| 范围 | 证据 / 边界 |
| --- | --- |
| 核心、存储、渲染、队列、LLM / Agent、导出、同步 | `npm run test:release`；包含完整 `npm test`、产品门禁、桌面与全新服务包测试 |
| 桌面专项 | 最终 122 项中 121 通过，1 个视觉项单独启用；独立视觉 3/3 通过 |
| 桌面真实生命周期 | `npm run test:desktop:smoke`；隔离数据、真实 Tray / Dock、关闭重开、第二进程让位和正常退出，不改用户 Chrome 注册 |
| 扩展真实浏览器 | `npm run test:release:browser`；开发 / 商店加载、首次连接、配置、草稿、模型列表、Agent 取消、阅读库、备份、历史答案与真实测试 Markdown 落盘 |
| 最终 ZIP | 解压待上传 ZIP，原 `sw.js` / `app.js` 字节不变；非安全 HTTP 下实际批注、刷新恢复、下载、公式 / 列表 / 表格在三处渲染及恶意 HTML 不执行 |
| 原生传输协议 | 同意门槛、取消、断线、错误响应、实际最终 SW 凭据隔离、真实临时 core 的逐实例鉴权 / 撤销；OS Native 通道本身为窄模拟 |
| 实际 OS 原生联调 | 冻结 DMG 覆盖安装后注册、宿主唤醒；真实 Chromium、未修改的最终 SW、用户两次原生允许、实际 health / 刷新 / GUI 撤销 / 重连 / 最终撤销；取消和 65 秒期限单独验证 |
| 官网 | 1440 / 390 双尺寸、导航、锚点、资源、隐私、无横向溢出 / 控制台错误、无虚假平台下载；只给实际 Mac ARM64 包与 SHA 提供入口 |
| Mac 包 | 匿名内容签名校验、内置 Node / SQLite 服务脱离源码启动、生产依赖完整、无配置或配对凭证随包 |
| 依赖 | 本轮 `npm audit --omit=dev --audit-level=high` 为 0 已知漏洞；不代表无未知漏洞 |

浏览器采用隔离 Chromium 151，模型和 Agent 调用使用受控模拟 / 临时子进程，不使用私人账号、生产密钥或收费模型。扩展商店安装后的审核 / 权限升级由 Chrome 控制，不能仅靠模拟宣称已经通过。

## 冻结的发布文件

- Chrome：`contextflow-chrome-1.1.0.zip`
  - SHA-256：`f3efcada584616b7c2f061664007492585a864a71e2f426a2c7d4f0bfd95c3a2`
- Mac ARM64：`ContextFlow-1.1.0-mac-arm64.dmg`
  - SHA-256：`120157ccb31a257c731bfa847e6dfa8ce6612f5d3bb2b936bd4660f3f3db98ef`

只上传已验收的这份 ZIP，不在后台上传后重新构建同版本附件。源码冻结提交通过版本 tag 绑定；任何后续功能变更使用新版本，不移动冻结 tag。

## 未宣称覆盖的范围

- Developer ID / Apple 公证、Gatekeeper 默认放行及其他 Mac 的干净安装；官网明确没有这两项认证，系统可能阻止打开。
- Windows、Intel Mac、ARM64 Windows 的完整用户实机安装与升级；未开放相应官网下载。
- CI 已实际运行并通过，不将其当成所有目标系统的人工干净安装或浏览器注册验收。
- 当前 Apple Silicon 用户环境的注册、唤醒、覆盖升级和原生授权已实际验证；不外推到其他机器，也不由 worker mock 或 Electron 测试回调冒充。
- 不宣称所有模型供应商、所有 Agent 版本或所有网页结构均无兼容性问题。

Chrome 上传、最终提交确认、公开 Release / 官网校验属于独立外部步骤，必须读取实际后台与 HTTPS 结果后记录；本页不预先宣称已送审或已上线。

## 送审最后核对（2026-10-24 00:10 北京时间）

- 产物源码冻结为 `b6312f9a9a94b2767fb44a192695a84f3f21c41e`，远端 tag `v1.1.0` 指向该提交；未移动原有 tag。之后的 `b823fb2` / `73bc892` / `f71f3dc` 仅修正 CRLF、zlib 与 Windows ASAR 校验路径可移植性，不改变产品 App / 扩展代码、PNG 或冻结 ZIP / DMG。
- 原 Chrome 条目已接收上述最终 ZIP，文件包页实际显示草稿 **1.1.0**、已发布 **1.0.0**；草稿权限为 storage / nativeMessaging / host permission。
- 已保存并重新加载核对新版产品说明、首页 / 支持 URL、nativeMessaging 理由、隐私披露与无远程代码声明；两张真实阅读截图保留。490 字审核说明已保存，用户名与密码均为空。
- 经用户明确允许，已正常退出旧应用，从冻结 DMG 安装 `/Applications/ContextFlow.app` 1.1.0 direct。旧应用及状态 / 数据在本机缓存目录留有保护副本。新版实际启动，系统密钥读取正常，配置与密钥封装文件逐字节未变，原有回答 / 同步验证状态保留；原生注册只允许正式商店 ID。
- `test/store-native-live-browser.test.mjs` 对原 ZIP 的临时副本只补公开公钥，不改 SW / app，不模拟 Native Messaging，不改 7317。真实 Chrome 协议触发原生宿主与 `--hidden` 桌面冷启动。实际取消与完整 65 秒期限均通过，浏览器无凭据、真实 API 拒绝未授权访问；核对测试授权为零，旧授权逐项不变。为避免读取个人配置或调用模型，浏览器只准实际 GET /health，其他服务请求直接拒绝，不伪造成功响应。
- 首次人工等待因脚本 30 秒边界过短退出，不计通过；修正等待边界后，在 2026-10-23 23:54–23:56 单独继续 allow 阶段，用户现场两次批准。真实首次连接、刷新保留、GUI 撤销后实际 401、同实例重新批准和最终撤销全部通过，脚本 exit 0。测试结束核对无活动测试授权，旧授权逐项不变，配置与密钥封装字节不变；未调用个人模型或同步私人笔记。
- 升级比对和实际安装：应用标识、状态 / 数据 / 密钥路径与核心格式保持一致；系统 Keychain 读取、原配置及验证状态保留已在这台 Mac 验收。仍须先结束任务、退出旧应用再覆盖，不宣称自动接管旧服务。
- 用户完成受保护的 GitHub workflow 授权后，main / tag 已成功推送。v1.1.0 Release 已公开，prerelease、非 latest；8 个附件以无登录 HTTPS 实际下载，全部 HTTP 200，全部字节摘要与本地冻结文件相同。
- 远端矩阵曾暴露 Windows 文档 / SVG 的 CRLF、Mac zlib 字节比较及 Windows ASAR 分隔符误报；保留完整像素 / CRC / 必需文件和缺失拒绝检查，仅修验收可移植性。最终 `f71f3dc` 的[核心 CI](https://github.com/PengheLiu/ContextFlow/actions/runs/39982748464)及[三平台桌面 CI](https://github.com/PengheLiu/ContextFlow/actions/runs/39982751306)均 success，含实际隔离生命周期、构建、包校验与内置 SQLite 服务启动。本地最新 `npm run test:release` 也完整 exit 0。
- 官网 Pages 提交 `0c28cb6d3fb72e2d658cfcc50caf17b42d1b1a01` 已 built。8 个公开官网文件逐字节匹配验收源码；公开首页 / 下载 / 隐私 / 练习页、1.0 兼容包和 1.1 下载检查均通过，线上 1440 / 390 导航、图片与无溢出 / 无 console 错误通过。网站补充一键连接需扩展 1.1.0+ 的系统要求，不用预览标签、不承诺缺少的入口可用；该文档级部署不覆盖冻结 site ZIP。
- **本节记录时仍未点击 Chrome 最终提交。** 必须读取后台成功确认与待审核状态，才能在下节记为已送审；不能把 Release / Pages 或所有测试通过当成 Google 已审核通过。
