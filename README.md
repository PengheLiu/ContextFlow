<p align="center">
  <img src="assets/logo.png#gh-light-mode-only" alt="ContextFlow" width="420">
  <img src="assets/logo-dark.png#gh-dark-mode-only" alt="ContextFlow" width="420">
</p>

<p align="center">
  <b>读过的东西，别只剩几条高亮。</b><br>
  <sub><a href="./README.en.md">English</a></sub>
</p>

---

## 一个熟悉的场景

你在读一篇论文。看到 `Threat model` 这一节，心想"它到底假设了攻击者能做什么"——
于是切到另一个标签页问 AI。答案还行，你点点头，关掉标签页。

三周后你在写方案，隐约记得"好像读过一篇讲这个的"。翻收藏夹，找到了那篇论文，
但当时的那个问题、那个答案、以及你在旁边写的那句"可行性如何呢"，都不在了。

**你花在理解上的功夫，一次性消耗掉了。**

真正值得留下的不只是高亮的那几行，还有：你当时不懂什么、问了什么、
被什么说服了、对什么持怀疑。这些才是你和这篇文章之间真正发生的事。

ContextFlow 把它们留下来，然后放进**你自己的笔记库**。

---

## 它做四件事

在网页上划词，工具条出现：

| | |
|---|---|
| 🎨 **高亮批注** | 四色高亮，旁边写你的想法 |
| 🌐 **翻译** | 术语跟着全文上下文走，不会同一个词前后两种译法 |
| ❓ **解释** | 选中一段，问你想问的。可以交给你本机的 AI agent |
| 📝 **总结** | 读完写几句，和上面三类一起沉淀 |

刷新页面，高亮回到原位。点原文的标记跳到对应记录，点记录跳回原文。

---

## 让它不一样的那件事

「解释」可以交给**你电脑上已经装好的 AI agent**（Claude Code、Codex……），
而不是又一个网页里的聊天框。

区别在于：agent 能读你自己的东西。

真实的一次输出 —— 选中论文里的 `Threat model` 一节，问"这段在讲什么"：

> 这一节划定攻击者的能力边界，共三条假设：
> 1. **黑盒访问**：只能通过公开 API 与模型交互……
> 2. **无白盒信息**：拿不到权重与梯度，无法做基于梯度的攻击
> 3. **强查询能力**：可发起大量自适应查询，且能控制系统提示
>
> 笔记里有：`阅读记录/2026-08-19.md` 里你在 attacker's server 一段旁批了
> 「可行性如何呢」，**正对应这里第 3 条假设的现实性**。

最后那句是关键。它翻到了我几天前写下的一句怀疑，并把它接到了论文的假设上。

**网页版 AI 做不到这件事** —— 它们看不见你的笔记。你本机的 agent 可以。

> 这类回答要几十秒。所以点了提问就能关掉窗口继续读 —— 原文上留一个待完成的记号，
> 答案回来了自己出现在面板里。同一段问过的问题会直接命中本地缓存，不再跑第二次。

---

## 落到你自己的笔记里

一键同步。**一篇文章一个文档**，四类记录各一个标题：

```markdown
# Stealing Reasoning Traces from Proprietary LLM APIs

## 翻译
> Threat model
威胁模型

## 解释
**❓ 这段在讲什么**
> Threat model
这一节划定攻击者的能力边界，共三条假设……

## 批注
> attackers can only query the model through its public API
💬 这个假设很关键，决定了攻击成本

## 总结
本文提出通过公开 API 反推推理痕迹的攻击。
待验证：对开启摘要模式的模型是否仍有效。
```

支持 **思源笔记**、**Obsidian**，或者就是**一个普通文件夹里的 Markdown**。

跨天读同一篇，永远追加到同一个文档；改了总结再同步是原地改写，不会多出一份；
重复点同步不产生重复内容。

---

## 全部在本地

这不是一句口号，是架构决定的：

- 一个跑在 `127.0.0.1` 的小服务，数据存在你机器上的 SQLite
- **API key 只存在于那个服务里**，从不进入浏览器脚本
- 笔记直接写进你的文件夹或笔记软件，不经任何第三方
- 没有账号，没有云端。服务没开也能标注 —— 先记在本地，服务起来后自动补发

装成 Chrome 扩展时更进一步：网络请求发生在 service worker 里，
连页面 JavaScript 都碰不到你的凭证。

---

## 开始用

需要 **Node ≥ 22.5**（用内置 SQLite，不编译原生模块）。

```bash
git clone https://github.com/PengheLiu/ContextFlow.git
cd ContextFlow && npm install
npm run server        # 首次启动会生成 ~/.contextflow/config.json
npm run build:ext     # 会打印扩展 id
```

Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选
`extension/dist`。

然后在页面右侧面板点「配置」：填一个 LLM 的地址与 key（翻译用，有「获取可选模型」
按钮），选笔记库位置。想让「解释」走本机 agent 的，在那里点「检测」挑一个。

<details>
<summary>不想装扩展？也可以当 userscript 用</summary>

```bash
npm run build:skill   # 产出 dist/skill.js
```

把 `dist/skill.js` 粘进 Tampermonkey / Violentmonkey 之类的宿主，绑定目标页面。

代价：这条路 token 会编译进脚本、与页面共享 JavaScript 环境，安全性弱于扩展。
</details>

<details>
<summary>几个可能想改的配置</summary>

`~/.contextflow/config.json`：

| 键 | 说明 |
|---|---|
| `explain.backend` | `llm`（快，几秒）或 `agent`（慢，但能读你的笔记） |
| `agent.id` / `agent.notesDir` | 用哪个本机 agent、让它读哪个笔记目录 |
| `translate.chunkChars` | 每次喂给模型的正文长度（默认 5000）。填 `0` 就不带上下文 |
| `sync.backend` | `siyuan` / `obsidian` / `markdown` |
| `allowedOrigins` | 哪些来源可以访问本地服务。装扩展后可以只放行扩展本身 |

</details>

---

## 已知边界

- arxiv 的 `/pdf/` 页走浏览器内置 PDF 阅读器，脚本进不去，那种页面标注不了。
  用 `/abs/` 或 `/html/` 版本。
- 「解释」走本机 agent 一次要几十秒，且消耗那个 agent 的额度。嫌慢嫌贵切回 `llm`。
- 页面大改版后个别高亮可能对不上原位。这种会被标成「失锚」列在面板里，不会悄悄消失。

---

## 想知道为什么这样做

[DESIGN.md](./DESIGN.md) 记着一路的取舍与实测数据 —— 高亮为什么用 CSS Custom
Highlight API 而不是往页面塞 `<span>`、锚点三层降级各自的命中率、为什么翻译不值得
走 agent（实测贵一到两个数量级）、连续对话怎么稳定命中缓存。

也记着几个只有真跑过才知道的坑，比如「只配工具白名单是不够的」。

## 许可

MIT。个人项目，按现状提供。
