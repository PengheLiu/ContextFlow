<p align="center">
  <img src="assets/logo.png#gh-light-mode-only" alt="ContextFlow" width="420">
  <img src="assets/logo-dark.png#gh-dark-mode-only" alt="ContextFlow" width="420">
</p>

<p align="center">
  <b>Reading leaves more behind than a few highlights. Keep it.</b><br>
  <sub><a href="./README.md">中文</a></sub>
</p>

---

## A familiar afternoon

You're reading a paper. You hit the `Threat model` section and wonder what exactly it
assumes the attacker can do — so you flip to another tab and ask an AI. The answer is
decent. You nod, close the tab.

Three weeks later you're writing a design doc and you half-remember reading something
about this. You dig up the paper. But the question you asked, the answer you got, and
the "is this even feasible?" you scribbled in the margin — all gone.

**The work you put into understanding it was spent, not saved.**

What's worth keeping isn't only the sentences you highlighted. It's what confused you,
what you asked, what convinced you, what you doubted. That's what actually happened
between you and that paper.

ContextFlow keeps it — and puts it in **your own notes**.

---

## Four things, on any page

Select text and a toolbar appears:

| | |
|---|---|
| 🎨 **Highlight & annotate** | Four colors, your thought next to it |
| 🌐 **Translate** | Terminology follows the whole article, so one term doesn't get two translations |
| ❓ **Explain** | Select a passage, ask what you actually want to know — optionally via an AI agent on your machine |
| 📝 **Summarize** | A few lines when you're done, stored alongside the rest |

Reload the page and highlights land back where they were. Click a mark in the article to
jump to its record; click the record to jump back to the text.

---

## The part that's actually different

**Explain** can be handed to an AI agent **already installed on your computer**
(Claude Code, Codex, …) instead of yet another chat box in a browser tab.

The difference: that agent can read *your* stuff.

A real answer — I selected the paper's `Threat model` section and asked what it's about:

> This section draws the attacker's capability boundary. Three assumptions:
> 1. **Black-box access** — interaction only through the public API…
> 2. **No white-box information** — no weights, no gradients, so no gradient-based attacks
> 3. **Strong query budget** — many adaptive queries, and control of the system prompt
>
> From your notes: in `reading/2026-08-19.md` you wrote "is this even feasible?" next to
> the *attacker's server* passage — **that's exactly the realism of assumption 3 here**.

That last line is the point. It found a doubt I'd written down days earlier and connected
it to the paper's assumption.

**No browser-tab AI can do that** — it can't see your notes. The agent on your machine can.

> These answers take tens of seconds, so you can fire the question and close the window.
> A pending mark stays on the passage; the answer shows up in the panel when it lands.
> Ask the same thing again and it comes straight from a local cache — no second run.

---

## It lands in your own notes

One click to sync. **One document per article**, one heading per kind of record:

```markdown
# Stealing Reasoning Traces from Proprietary LLM APIs

## Translation
> Threat model
威胁模型

## Explanations
**❓ What is this section about?**
> Threat model
This section draws the attacker's capability boundary. Three assumptions…

## Annotations
> attackers can only query the model through its public API
💬 This assumption is what sets the attack cost.

## Summary
Recovers reasoning traces through a public API.
To verify: does it still work against models with summarized-reasoning mode on?
```

Works with **SiYuan**, **Obsidian**, or just **Markdown files in a plain folder**.

Read the same article across several days and everything appends to the same document.
Edit your summary and re-sync — it rewrites in place instead of adding a second copy.
Clicking sync twice never duplicates anything.

---

## Everything stays local

Not a slogan — it falls out of the architecture:

- A small service on `127.0.0.1`, data in SQLite on your own machine
- **API keys live only in that service** and never reach browser-side code
- Notes are written straight into your folder or note app, through no third party
- No account, no cloud. Annotate with the service down — it's saved locally and pushed
  when the service comes back

As a Chrome extension it goes one step further: network calls happen in the service
worker, so not even page JavaScript can touch your credentials.

---

## Getting started

Needs **Node ≥ 22.5** (uses the built-in SQLite, so nothing to compile).

```bash
git clone https://github.com/PengheLiu/ContextFlow.git
cd ContextFlow && npm install
npm run server        # first run creates ~/.contextflow/config.json
npm run build:ext     # prints the extension id
```

In Chrome: `chrome://extensions` → Developer mode → Load unpacked → pick
`extension/dist`.

Then open the panel on the right and hit **配置** (Settings): point it at an LLM endpoint
and key (used for translation — there's a "fetch available models" button), and choose
where your notes live. To route **Explain** through a local agent, hit **检测** (Detect)
there and pick one.

> **Heads up:** the UI and the generated notes are in Chinese. Explanations come back in
> Chinese by default too. If you'd want an English UI, open an issue — it's a matter of
> extracting the strings, not a redesign.

<details>
<summary>Prefer a userscript over an extension?</summary>

```bash
npm run build:skill   # produces dist/skill.js
```

Paste `dist/skill.js` into Tampermonkey / Violentmonkey and bind it to the pages you want.

The tradeoff: this path compiles the token into the script and shares the page's
JavaScript environment, so it's weaker than the extension.
</details>

<details>
<summary>Settings you might want to change</summary>

`~/.contextflow/config.json`:

| Key | What it does |
|---|---|
| `explain.backend` | `llm` (seconds) or `agent` (much slower, but reads your notes) |
| `agent.id` / `agent.notesDir` | Which local agent, and which notes directory it may read |
| `translate.chunkChars` | How much article text to feed per turn (default 5000). `0` disables article context |
| `sync.backend` | `siyuan` / `obsidian` / `markdown` |
| `allowedOrigins` | Who may reach the local service. With the extension you can allow only the extension itself |

</details>

---

## Known limits

- arxiv `/pdf/` pages render in the browser's built-in PDF viewer, which scripts can't
  enter — no annotating there. Use the `/abs/` or `/html/` version.
- Explain-via-local-agent takes tens of seconds and spends that agent's quota.
  Switch back to `llm` if that's the wrong trade for you.
- After a heavy page redesign a highlight may not resolve. Those are marked as orphaned
  and listed in the panel — never silently dropped.

---

## Why it's built this way

[DESIGN.md](./DESIGN.md) (Chinese) records the tradeoffs and the measurements behind them
— why highlighting uses the CSS Custom Highlight API instead of injecting `<span>`s, the
hit rates of each anchoring tier, why translation isn't worth an agent (one to two orders
of magnitude more expensive, measured), and how the running conversation keeps hitting
the prompt cache.

It also records a few things only running the thing teaches you, like "an allow-list of
tools is not enough".

## License

MIT. A personal project, provided as is.
