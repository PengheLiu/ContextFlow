<div align="center">

<img src="./assets/mark.svg" alt="" width="64" height="64">

<h1>ContextFlow</h1>

<h3>Turn what you read into context you can reuse.</h3>

<p>Think beside the source. Go deeper with AI. Keep the knowledge in your own tools.</p>

<p>
  <a href="https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm"><strong>Install from Chrome Web Store</strong></a>
  · <a href="#get-started">Get started</a>
  · <a href="./README.md">中文</a>
</p>

<p><sub>Open source · Local-first · Markdown · Obsidian · SiYuan</sub></p>

</div>

> **Available on Chrome Web Store:** as of October 19, 2026, the store version is v0.3.1. The v0.3.2 guided connection and in-page settings update has been submitted to Google and will publish automatically after approval. The [v0.3.2 companion service](https://github.com/PengheLiu/ContextFlow/releases/tag/v0.3.2) is available now. Follow the [setup guide](./docs/GETTING_STARTED.md) for the current store version. The extension UI is primarily in Chinese.

ContextFlow is a browser reading workspace for people who read to understand. Keep **passages, questions, and your own judgments** together as you work through papers, technical articles, and research reports—then bring them back to your notes.

<img src="./assets/readme/inline-annotation.png" alt="Actual extension UI: write beside a selected passage while the same annotation appears in the reading panel" width="100%">

<sub>Write beside the source; review in the panel. Captured from the v0.3.2 development build using original sample text and an example annotation. Inline annotations, panel mirroring, and Markdown export are already available in v0.3.1.</sub>

## Keep more than the article. Keep why it mattered.

### Think without leaving the source

Select a passage to highlight it, write an inline annotation, or paste a screenshot. Capture a thought where it occurs without moving it to a separate document first.

The inline editor and reading panel share **one record**. Write in place, review in the panel, and jump back to the original passage. ContextFlow attempts to restore saved highlights when you revisit the article.

### Follow the question, in context

Explain or translate a selection and ask follow-up questions on the page. Start with an overview of a long article, then investigate the passages that matter. AI results stay with your reading records, alongside your own additions and pasted images.

Choose your own model or local agent. AI requires the optional companion service; annotations and export work independently.

### Bring the reading back to your notes

Copy or download Markdown that includes the source, reading records, and your own summary. With the companion connected, sync to **Obsidian, a Markdown folder, or SiYuan**.

The same article updates the same note rather than creating a new copy on every sync. Input saves automatically in the browser; writing to your note destination happens when you click **同步** (Sync). Your notes remain portable and editable in your own tools.

## Bring earlier understanding into what you read now

Your notes can be more than an output destination. Give a local agent permission to read a chosen notes directory, then ask questions that connect the current article to earlier work:

- **Compare perspectives:** How does this conclusion differ from my previous understanding?
- **Find connections:** Which notes discuss the same problem?
- **Continue an investigation:** Does this evidence answer a question I left open?

ContextFlow connects the web, AI, and your existing knowledge rather than creating another closed collection. Retrieval and answer quality depend on your agent, permissions, and notes. Verify important conclusions against the sources. [Product philosophy (Chinese) →](./docs/PRODUCT.md)

## Get started

**Start with useful reading, not AI configuration.** Highlights, inline annotations, pasted images, and Markdown export need no account, API key, Node.js, or running service.

1. **Install.** Choose **Add to Chrome** on the [Chrome Web Store](https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm). No ZIP download or Developer mode is needed.
2. **Capture a thought.** Refresh an article, select a sentence, and click **批注** (Annotate). The [practice article](https://pengheliu.github.io/ContextFlow/demo.html) provides a guided first use.
3. **Keep the result.** Open the right-hand reading panel and click **下载** (Download) for Markdown containing your source and annotations.

[Full installation and troubleshooting guide (Chinese) →](./docs/GETTING_STARTED.md)

Works on ordinary web pages in desktop Chrome / Chromium 111+. Chrome internal pages, Web Store pages, and the built-in PDF viewer are not supported.

### Enable only what your workflow needs

| Capability | Requirements |
| --- | --- |
| Highlights, inline annotations, pasted images, Markdown export | Extension only |
| Sync to Obsidian / Markdown / SiYuan | Local companion and an output destination; AI is optional |
| AI overviews, explanations, follow-up questions, translation | Local companion and your own model or agent configuration |
| Answers informed by personal notes | Local agent and explicit permission to read a notes directory |

The companion requires Node.js 22.13+ and currently uses terminal-based installation and startup. Model charges are set by your provider; ContextFlow includes no model credits. [Companion setup (Chinese) →](./docs/GETTING_STARTED.md#开启-ai-和笔记同步)

## Your tools. Your data. Explicit permissions.

- **Local-first, without a reading-history cloud account.** Browser records live in extension-private storage. The companion runs on your computer and writes to your selected directory or note service.
- **AI destinations are your choice.** Article content, questions, and authorized note excerpts may be sent to the model or agent services you configure. Local-first does not mean all AI runs offline.
- **Grant access deliberately.** Local agents default to a restricted profile; full permissions require an explicit choice. Never include pairing codes, API keys, or private notes in public reports.

Export or sync regularly. Uninstalling the extension clears its browser records, not exported files or synced notes. Changes to a web page can also affect highlight restoration.

[Privacy policy](https://pengheliu.github.io/ContextFlow/privacy.html) · [Storage and upgrade notes (Chinese)](./docs/GETTING_STARTED.md#日常运行与升级)

## Feedback and contribution

[Report a bug or suggest an improvement](https://github.com/PengheLiu/ContextFlow/issues). Include your extension version, browser version, reproduction steps, and a redacted screenshot.

[Releases](https://github.com/PengheLiu/ContextFlow/releases) · [Development guide](./docs/DEVELOPMENT.md) · [Architecture and security](./DESIGN.md) · [MIT License](./LICENSE)
