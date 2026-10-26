# 1.1 独立桌面分发与当前状态

核查日期：2026-10-26。本页区分源码候选、公开产品和待验证条件，不把本机可用写成 Chrome 已审核通过。

## 当前可用的版本

| 入口 | 核实状态 |
| --- | --- |
| Chrome 商店 | 上次核对：1.0.0 已上线，1.1.0 于 2026-10-24 提交待审核；本轮 1.1.1 提交尚待确认，不凭 GitHub 发布声明已送审 |
| GitHub Release | v1.1.1 已公开为 latest，8 个附件摘要与本地一致；旧 v1.1.0 / v1.0.0 的 tag 和附件均保留 |
| 当前源码 | 1.1.1，preview；本轮配置状态、恢复与发布保护修正版，不覆盖已冻结的 1.1.0 |
| 新桌面端 | Mac ARM64 1.1.1（direct）独立分发，仅允许商店扩展连接；无 Developer ID 签名 / Apple 公证；其他架构未开放下载 |
| 本机验证 | Apple Silicon 冻结 DMG 覆盖安装、真实原生授权 / 撤销重连通过；不是 Intel / Windows 干净实机、签名或公证证明 |

唯一机器可读状态为 [product/release.json](../product/release.json)。README、官网安装提示、下载状态、根目录 / 桌面版本与锁文件都必须与它一致。公开状态带核查日期，离线检查不冒充实时验证。

2026-10-23 初次审查时线上 `download.html` 为 404。本轮 GitHub main / tag、独立 Release 与 Pages 已实际更新，8 个下载文件及 8 个官网文件均通过无登录 HTTPS 字节核验。官网在下载前明确一键连接需要扩展 1.1.0+ 及相应入口，商店可安装版本以实际页面为准；不通过卸载解决缺少入口。三条发布链仍独立；Chrome 已送审由后台成功回执单独确认，不等于审核通过或上线。

## 独立分发的边界

用户选择暂不购买签名证书、直接提供官网下载。这不要求进入 Mac App Store；但不进商店并不消除 Gatekeeper 对下载应用的检查。官网不使用“预览版”标签，直接称“桌面客户端”，同时如实说明未签名、未公证及仅 Apple Silicon 本机验证的范围。参见 [Apple 的安全打开说明](https://support.apple.com/102445)。不提供关闭系统保护的命令，也不承诺未签名应用在其他 Mac 上必然顺利打开。

上一轮桌面、companion、Chrome 和网站 ZIP 统一使用 tag `v1.1.0`，GitHub 标为 prerelease、非 latest，不覆盖 `v1.0.0`，也不伪装成 Chrome 扩展 1.1 已上线。本轮源码候选已递增至 1.1.1；不能用新代码覆盖任何 1.1.0 包或校验和。发布记录用 `available-unsigned` 单独表示“可下载但未签名”，不等于签名发行的 `published`。官网 DMG 与 SHA 必须先实际可访问；Windows x64 只有构建验证，不开放主要下载入口。今后签名与目标系统验收完成后，必须使用更高版本进入严格签名发行，不覆盖此 tag。

官网独立包使用 `desktop:prepare -- --direct`，原生桥接只允许正式商店 ID，不沿用开发构建的额外扩展 ID。Mac 采用匿名 ad-hoc 内容完整性封装并要求整包 `codesign --verify --deep --strict` 通过；这不是 Developer ID 身份认证，也不是 Apple 公证。该渠道不降低未来 `--release` 对证书与验收的要求。

## 本轮修正

- 普通用户先安装 Chrome 扩展，需要 AI / 同步时再从官网下载桌面端。不再把 npm 或手工配置作为默认入门。
- 浏览器授权 → AI 草稿测试 / 显式保存 → 独立笔记位置确认 → 网页实际回答 / 同步，顺序和界面名称一致。
- 桌面连接保持原生流程：由扩展发起申请、桌面端核对来源后明确授权，不新增桌面端生成配对码的功能。新原生权限随 1.1 扩展单独送审。
- 商店公开 1.0 的兼容指南固定到 v1.0.0，避免跟随候选版本点到未发布 ZIP。
- 凭据加密不等于阅读数据加密；浏览器备份、本机恢复点和外部笔记文件范围分别说明。
- 关闭窗口继续运行并保留 Mac Dock；菜单栏状态、授权撤销、官网手动更新与真实界面一致。
- 移除未验证的应用内自动安装：不会为更新先关闭可用的 core / bridge 后等待不确定的安装器。首发不承诺自动更新；未来启用须独立验证签名、架构路由和失败恢复。
- macOS 最低版本设为 13.5，与内置 Node 24 官方运行时一致；基础扩展浏览器要求不因此改变。
- 桌面安装包随包生成 SHA-256 校验文件。校验用于发现文件损坏，不替代发布者签名或可信下载来源。
- 构建所需 Node 许可固定版本及摘要，复用已校验缓存；网络获取限时重试，拒绝错误页面或不匹配内容，不再因一次许可下载超时直接卡住整个平台构建。
- 旧审核与发行记录明确标记为历史，不复用“无新增权限 / 待审核”等过时结论。

## 本轮验证记录

2026-10-25 的 1.1.1 本地修正版完成四端复核：`test:release`、Chromium 全流程、独立 Electron 布局 / 生命周期、已安装 Codex 与 DeepSeek Harness 的隔离协议测试通过。最终 1.1.1 商店 ZIP 直接解压回归通过，新 DMG 经只读挂载验证版本、整包完整性及包内运行时启动。Personal 配置的受限真实连接测试约 12 秒通过，原账号与配置未改变。新增回归覆盖同目录 Codex 模型 / 登录文件变化使旧测试失效、测试中配置变化拒绝沿用结果、授权记录损坏时仍可诊断和恢复，以及同名不同内容产物拒绝覆盖。本轮没有替换个人已安装客户端、更新线上资源或重新提交审核；未将这些本地结果视作新的 Windows 实机或人工原生授权证明。

2026-10-23 至 24 日，本地完整 `test:release`、最终 ZIP 浏览器回归、视觉与生命周期 smoke 通过；实际 Mac 覆盖安装及用户两次原生允许、刷新、撤销 / 重连 / 清理通过。`f71f3dc` 的核心 CI 和 Windows x64 / Mac ARM / Intel 桌面矩阵全部 success，包含真实内置服务启动。官网桌面 / 窄屏、公开资源与无外部自动请求验收通过。证据及边界见[完整审计](./RELEASE_AUDIT_1_1.md)，这些仍不等于 Google 审核通过。

1.1.0 的 Chrome、companion、静态官网 ZIP 和 Mac ARM64 DMG 已公开并附 SHA-256；Windows / Intel 包通过 CI 构建、隔离生命周期和包校验，但没有人工干净安装 / Chrome 注册验收，不提供官网下载。Mac 没有 Developer ID 签名 / 公证，Windows 安装器没有 Authenticode 签名，不宣称受系统信任。经用户明确允许，已备份并正常退出旧应用，从冻结 DMG 覆盖安装本机 1.1；配置、密钥和旧授权保留，测试授权已清理。

独立分发检查必须核对真实 DMG、SHA 与记录一致，以及公开下载与官网返回成功。严格的签名发行门禁仍因 preview 源码渠道及缺少签名证据拒绝通过；不修改门禁来伪造签名、公证或实机报告。

## 可重复的本地检查

```bash
npm ci
npm run check:product
npm run test:product
npm test
npm run test:store-support
npm run desktop:install
npm run test:desktop
npm run desktop:prepare
npm run test:desktop:smoke
```

已安装桌面开发依赖后，可用 `npm run test:release` 顺序重跑核心、产品、桌面和服务包测试。构建待上传 ZIP 与官网后，以已有 Playwright 运行目录设置 `CONTEXTFLOW_PLAYWRIGHT_DIR`，运行 `npm run test:release:browser`；其中产物验收直接解压最终 ZIP，不重建或改写 `sw.js` / `app.js`，只为固定商店 ID 在隔离副本添加公开公钥。它验证真实浏览器与临时 core，但 Native Messaging 的 OS 传输用窄模拟替代，不冒充系统注册 / 用户桌面授权的实机证明。

真实 Mac 原生联调另用显式 opt-in 的 `test/store-native-live-browser.test.mjs`，需要用户现场允许临时浏览器并在桌面仅撤销该测试实例。它不调用模型、不改配置、不同步笔记；不要加入无人值守的默认测试，也不能因省略 opt-in 而宣称该联调通过。

真实网页与扩展验收使用已有的隔离 Playwright / Chromium 环境；命令及范围见[开发指南](./DEVELOPMENT.md)。不能把模拟模型、native callback 或本机截图当作付费模型、OS 指针命中或其他系统的完整验收。GitHub 已配置只读权限的核心质量及跨平台预览构建工作流，但本地通过不代表远端 CI 已执行；推送后须核对实际运行结果，不放置伪造的“已通过”徽章。

构建候选不会公开发布：

```bash
npm run build:store
npm run build:store-support
npm run build:website
npm --prefix desktop run dist -- --mac dmg --arm64 --artifact-subdir candidate-1-1-1
node tools/check-desktop-package.mjs
```

Win x64 必须先 `npm run desktop:prepare -- --platform win32 --arch x64`，再以 `--win nsis --x64 --artifact-subdir candidate-1-1-1` 构建并检查相应 `win-unpacked`。不要并行改写不同平台的 prepare 目录。Mac 生成 EXE 只证明构建 / 结构，不等于 Windows 安装通过。

## 签名正式发行前仍须完成

1. **源码冻结。** 将审阅通过的完整源码提交，使用新版本 tag；不要替换 v1.0.0。保持干净工作区，记录源码 commit 与每个包的 SHA。
2. **Mac。** Developer ID 签名、Apple 公证 / staple、Gatekeeper 验证；13.5+ 目标机器安装、休眠恢复、浏览器连接、读写及覆盖升级保留数据。Intel 必须单独验收，未验收不提供正式下载。
3. **Windows。** 受信任发布者签名；对应架构标准用户安装、路径含空格 / 中文、Chrome Native Messaging、Agent 子进程 / 取消、同步、关闭重开、升级和卸载保留数据的实机验收。x64 不能替代 ARM64。
4. **下载与证据一致。** 签名发行必须提供已验证的系统 / 架构、版本和校验；独立未签名渠道单独披露限制。其他目标继续标未开放，不放假的按钮，不引导关闭系统保护。
5. **公开入口。** 更新 GitHub 文档及 Pages 后执行 `npm run check:public-surface`；它检查已公开 companion / SHA、桌面 DMG / SHA、首页、下载页、隐私与练习页。再以浏览器检查版本、窄屏、FAQ、CTA 和实际资源。
6. **Chrome 候选。** 检查商店 ZIP 没有私人凭据，新增 nativeMessaging 的用途与数据披露匹配；先让匹配桌面 / 兼容服务可下载，再在原条目上传尚未使用的候选版本（本轮源码为 1.1.1）并提交审核。1.1.0 已上传，不用新内容覆盖或重复冒用该版本。没有后台确认不写“已提交”；没有公开版本证据不写“已上线”。

正式门禁用法：

```bash
node tools/check-product-release.mjs --release --manifest /absolute/path/to/release-manifest.json
```

门禁核对真实文件摘要、源码 / tag、目标系统、签名 / 公证和逐项验收报告；缺证据拒绝放行。当前 preview 不满足正式门禁，这是保护，不是可绕过的构建错误。清单示例及字段契约见 [product-release 测试](../test/product-release.test.mjs) 中的 `bundleFixture` / `evidence`。报告不是不可伪造的签名证明：维护者仍须审阅命令输出和真实目标机器记录；门禁不替代 Apple、Microsoft、Chrome 审核或用户的发布授权。

## 发布与回退边界

Chrome 商店更新、GitHub 源码 / Release 和官网是三条独立发布链。只更新官网不会更新已安装扩展；只生成安装包不会让用户能公开下载。

更新前分别导出浏览器阅读备份并保护服务数据 / 桌面密钥。覆盖安装不应重新配对或清空数据；桌面配置已加密后不能直接回退旧 CLI。发现故障先停止推广对应安装包、保留日志的脱敏摘要和冻结产物，不能用“卸载重装 / 删配置”充当通用修复。
