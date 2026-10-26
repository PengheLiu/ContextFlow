# ContextFlow 1.1.1 发布记录

日期：2026-10-26。

## 源码与公开分发

- 源码已推送 `main`；发行 tag `v1.1.1` 固定到 `b1744ff4816abe116617e8103f9ff314c7b8df6a`，不覆盖旧 tag。
- [GitHub Release v1.1.1](https://github.com/PengheLiu/ContextFlow/releases/tag/v1.1.1) 已公开为 latest；8 个附件的服务端摘要及大小与本地文件完全一致。
- [官网下载页](https://pengheliu.github.io/ContextFlow/download.html) 已部署 1.1.1，最新 Pages 提交为 `670bb1e72d1934819c826518d8c344cafb661285`，构建完成；8 个公开站点文件逐字节核对一致。下载和 SHA 地址均可访问。
- 公开 DMG 使用 `direct` 渠道，只允许正式商店扩展 ID。此前本地验证包允许开发插件连接，保留在独立目录，不作为官网安装包上传。
- 桌面仍采用手动更新，仅开放 Mac ARM64；未使用 Developer ID 签名或 Apple 公证。Windows / Intel 构建通过不等于人工干净安装验收，因此不开放下载。

## 验证

- [核心 CI](https://github.com/PengheLiu/ContextFlow/actions/runs/40256537807) 通过。
- [桌面矩阵 CI](https://github.com/PengheLiu/ContextFlow/actions/runs/40256607522) 的 Mac ARM64、Intel Mac、Windows x64 全部通过，包含隔离生命周期、打包和内置运行时核验。
- CI 构建的商店 ZIP 与本地最终解压验收包 SHA-256 完全相同。
- 本地全量回归、真实 Chromium 读写 / 公式 / 恢复、Electron 布局、Agent 协议和受限 Personal 连接测试通过；公开 direct 包另验封装完整性、原生白名单和内置服务独立启动。
- 本轮未替换个人已安装应用、修改账号配置、写入私人笔记或增加实际浏览器授权。未把窄模拟 Native Messaging 测试当作新的人工系统授权证明。

## 冻结附件

每个文件均带 `.sha256` 侧车。旧 1.1.0 附件保持不变。

| 文件 | SHA-256 |
| --- | --- |
| `ContextFlow-1.1.1-mac-arm64.dmg` | `cd677b20dd76e0544eb51ac02b1d8742aae7dbef9a32e08a7e448fdc939b414a` |
| `contextflow-chrome-1.1.1.zip` | `d2c96ae0d09cab97613f7f27d8e117a50b66617745d40937a41a2bb2e50cfb33` |
| `contextflow-companion-1.1.1.zip` | `0cef4d1616d0529bd9307e6b0e3db37a4f6914d4083b8910e285a1ad1a4e7e1d` |
| `contextflow-store-site-1.1.1.zip` | `7d4a2e034f01e766382ca10949c22502a3c872dede03b99fac73a1b085a99453` |

网站 ZIP 是发行时的静态快照；之后的状态文案可通过独立 Pages 部署更新，不覆盖已冻结 ZIP。

## Chrome 商店状态

商店权限与条目沿用已发布 1.1.0 的范围及同一 ID：`aemncphfnlpbhlddifhohpgegejjejfm`。2026-10-26 已通过 Chrome 原生界面核实「已发布」版本为 1.1.0，并上传上述精确 1.1.1 ZIP。

2026-10-26 10:16（北京时间），后台显示「已将您的扩展程序提交送审」，确认 1.1.1 已提交，保留审核通过后自动发布。提交后再次核对，文件包显示草稿 1.1.1、已发布 1.1.0，状态页显示「该草稿尚待审核」。当前为待审核，不代表 1.1.1 已获批或上线；公开版本记录仍为已核实的 1.1.0。GitHub 发布、ZIP 上传与 Chrome 审核是独立步骤。
