# ContextFlow

> 把网页阅读的过程沉淀成可检索的 context，而不只是几条高亮。

在浏览器里读 blog / arxiv 时做**划词翻译、解释、高亮批注、全文总结**，
一键同步到你自己的笔记库（思源 / Obsidian / 本地 Markdown）——
**一篇文章一个文档，四类记录各一个标题**。

解释可以交给你**本机已装的 coding agent**（Claude Code / Codex / …）。
这是它和"网页上再套一层 LLM"的根本区别：agent 能读你自己积累的语料。
实测输出片段：

> 笔记里有：`阅读记录/2026-08-19.md` 里你在 attacker's server 一段旁批了
> 「可行性如何呢」，**正对应这里第 3 条假设的现实性**。

---

## 它由两部分组成

```
┌─ 浏览器侧（userscript / 扩展）──┐      ┌─ 本地服务 127.0.0.1:7317 ─┐     ┌─ 笔记库 ──┐
│ 选区工具条（Shadow DOM）        │      │ POST /translate → LLM      │     │ 思源      │
│ 高亮渲染 + 命中测试             │◄────►│ POST /explain   → LLM/agent│────►│ Obsidian  │
│ 右侧四 tab 面板                 │ HTTP │ POST /events    → SQLite   │     │ Markdown  │
│ 离线 outbox                     │      │ 持有全部密钥                │     └───────────┘
└────────────────────────────────┘      └────────────────────────────┘
```

两条硬规则：

1. **所有密钥只在本地服务。** `GET /config` 永不回传密钥明文，只回 `apiKeySet` 这类布尔位。
   userscript 载体跑在页面 MAIN world，页面 JS 能读到它持有的一切；扩展载体把 fetch
   放进 service worker，token 不进页面 —— 这是推荐用扩展的原因。
2. **SQLite 是唯一事实源。** 浏览器侧只做 UI + 离线镜像。

## 依赖

- **Node ≥ 22.5**（用内置 `node:sqlite`，无需原生编译）
- 一个 OpenAI 兼容网关或 Anthropic API key（翻译用）
- 可选：本机的 coding agent（`claude` / `codex`），解释走 agent 时需要
- 可选：思源笔记（同步用）；不用也行，可以直接写 Obsidian vault 或普通目录

## 安装

```bash
git clone https://github.com/PengheLiu/ContextFlow.git
cd ContextFlow
npm install
npm run server          # 首次启动会生成 ~/.contextflow/config.json（含随机 token）
npm run build:skill     # 产出 dist/skill.js
```

把 `dist/skill.js` 粘进任意 userscript 宿主（Tampermonkey / Violentmonkey 等），
绑定你想标注的页面。**注意 `dist/` 不进版本库** —— 构建会把本地服务的 bearer token
注入产物。

### 或者装成 Chrome 扩展（推荐）

```bash
npm run build:ext       # 会打印扩展 id
```

`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/dist`。

**扩展比 userscript 严格更安全**：fetch 发生在 service worker，token 不进页面 JS 堆。
把构建打印的 `"chrome-extension://<id>"` 加进 `~/.contextflow/config.json` 的
`allowedOrigins`，就可以把 `allowAnyOrigin` 关掉 —— 「所有站点可用」与「白名单最强」
同时成立。

然后在页面右侧面板点「配置」，填 LLM 的 Base URL / API key / 模型（有「获取可选模型」
按钮），以及笔记库位置。

## 配置要点

`~/.contextflow/config.json`（模式 600）：

| 键 | 说明 |
|---|---|
| `allowedOrigins` | CORS 白名单，支持 `*` 单段通配 |
| `allowAnyOrigin` + `requireToken` | 要在任意站点上用就得开这两个，**必须成对** —— 只开前者等于对全网敞开数据库 |
| `translate.chunkChars` | 正文分段长度（默认 5000）。填 `0` 则不带正文上下文 |
| `explain.backend` | `llm` 或 `agent` |
| `agent.id` / `agent.notesDir` | 选哪个本地 agent、授予它读哪个笔记目录 |
| `sync.backend` | `siyuan` / `obsidian` / `markdown` |

## 几个不显然的设计

**锚定是最容易翻车的地方。** 刷新页面后高亮必须回原位，用三层降级：
归一化偏移 → `prefix+exact+suffix` 引文搜索 → 模糊匹配。全失败标记为失锚并在面板列出，
**不静默丢失**。面板底栏实时显示 `pos/quote/fuzzy/失锚` 分层计数 ——
那是验证降级是否真在工作的唯一手段。

**零 DOM 侵入。** 高亮走 CSS Custom Highlight API，不往页面塞 `<span>`，
所以不会被 React/Vue 的 re-render 冲掉，也不触发页面自身的 MutationObserver。
代价是拿不到 click 事件，用 `caretPositionFromPoint` 做命中测试补上。

**连续对话 + 分段供给。** 同一篇文章的翻译/解释在一个对话里完成，正文作首条消息、
之后只在末尾追加，前缀恒定所以能稳定命中 prompt cache。长文按 `chunkChars` 分段，
只喂到覆盖当前选区为止。

**提交即留痕。** agent 一次几十秒，守在浮层前等是最糟的交互。点提问的那一刻就落记录：
原文出现待完成标记、面板出现带进度的条目，浮层随时可关，刷新页面也能接上。

**同步是一文一档且幂等。** 重复点同步不产生重复块；已同步的内容改了会原地改写而不是
追加第二份（总结和评论是会被反复编辑的）。

更多设计取舍与实测数据见 [DESIGN.md](./DESIGN.md)。

## 测试

```bash
npm test
```

同步层（写进你笔记的那一层）、锚定层、agent 适配层都有覆盖 ——
那是最不该靠手工回归的部分。

## 许可

MIT，见 [LICENSE](./LICENSE)。个人项目，按现状提供。
