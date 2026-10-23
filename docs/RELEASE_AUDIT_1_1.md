# 1.1.0 送审前验收记录

日期：2026-10-23（北京时间）。本记录区分自动化、真实浏览器、原生系统和公开发布；测试通过不是“绝无 bug”的承诺。

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
| 桌面专项 | 118 项中 117 通过，1 个视觉项单独启用；独立视觉 3/3 通过 |
| 桌面真实生命周期 | `npm run test:desktop:smoke`；隔离数据、真实 Tray / Dock、关闭重开、第二进程让位和正常退出，不改用户 Chrome 注册 |
| 扩展真实浏览器 | `npm run test:release:browser`；开发 / 商店加载、首次连接、配置、草稿、模型列表、Agent 取消、阅读库、备份、历史答案与真实测试 Markdown 落盘 |
| 最终 ZIP | 解压待上传 ZIP，原 `sw.js` / `app.js` 字节不变；非安全 HTTP 下实际批注、刷新恢复、下载、公式 / 列表 / 表格在三处渲染及恶意 HTML 不执行 |
| 原生传输协议 | 同意门槛、取消、断线、错误响应、实际最终 SW 凭据隔离、真实临时 core 的逐实例鉴权 / 撤销；OS Native 通道本身为窄模拟 |
| 官网 | 1440 / 390 双尺寸、导航、锚点、资源、隐私、无横向溢出 / 控制台错误、无虚假平台下载；只给实际 Mac ARM64 包与 SHA 提供入口 |
| Mac 包 | 匿名内容签名校验、内置 Node / SQLite 服务脱离源码启动、生产依赖完整、无配置或配对凭证随包 |
| 依赖 | 本轮 `npm audit --omit=dev --audit-level=high` 为 0 已知漏洞；不代表无未知漏洞 |

浏览器采用隔离 Chromium 151，模型和 Agent 调用使用受控模拟 / 临时子进程，不使用私人账号、生产密钥或收费模型。扩展商店安装后的审核 / 权限升级由 Chrome 控制，不能仅靠模拟宣称已经通过。

## 冻结的待上传文件

- Chrome：`contextflow-chrome-1.1.0.zip`
  - SHA-256：`f3efcada584616b7c2f061664007492585a864a71e2f426a2c7d4f0bfd95c3a2`
- Mac ARM64：`ContextFlow-1.1.0-mac-arm64.dmg`
  - SHA-256：`120157ccb31a257c731bfa847e6dfa8ce6612f5d3bb2b936bd4660f3f3db98ef`

只上传已验收的这份 ZIP，不在后台上传后重新构建同版本附件。源码冻结提交通过版本 tag 绑定；任何后续功能变更使用新版本，不移动冻结 tag。

## 未宣称覆盖的范围

- Developer ID / Apple 公证、Gatekeeper 默认放行及其他 Mac 的干净安装；官网明确没有这两项认证，系统可能阻止打开。
- Windows、Intel Mac、ARM64 Windows 的完整用户实机安装与升级；未开放相应官网下载。
- 本机测试不等于远端 CI 已通过；实际运行结果在推送后核对。
- OS 原生注册、冷启动唤醒、原生鼠标点击授权和升级注册路径，不由 worker mock 或 Electron 测试回调冒充。
- 不宣称所有模型供应商、所有 Agent 版本或所有网页结构均无兼容性问题。

Chrome 上传、最终提交确认、公开 Release / 官网校验属于独立外部步骤，必须读取实际后台与 HTTPS 结果后记录；本页不预先宣称已送审或已上线。
