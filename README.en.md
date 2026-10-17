# ContextFlow

**Highlight a web page, annotate beside the source, and keep your reading notes as Markdown.** Add AI and your personal notes when you need them.

[Download](https://github.com/PengheLiu/ContextFlow/releases/latest) · [中文](./README.md) · [Practice article](https://pengheliu.github.io/ContextFlow/demo.html)

> v0.3.1 has been submitted to the Chrome Web Store and is awaiting review. Until approval, use the unpacked extension below. The v0.3.2 onboarding improvements in the source have not been released as an installation package. The extension UI is currently in Chinese.

## Start with one annotation

Highlights, annotations, image attachments, and Markdown export require **no account, Node.js, API key, or local service**.

1. Open the [v0.3.1 release](https://github.com/PengheLiu/ContextFlow/releases/tag/v0.3.1) and download **contextflow-chrome-0.3.1.zip**.
2. Extract it. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the extracted folder containing `manifest.json`. Refresh an ordinary article tab after installation.
4. Open the [practice article](https://pengheliu.github.io/ContextFlow/demo.html), select a sentence, and click **批注** (Annotate).
5. Write a thought beside the passage. Open the right-hand reading panel and click **下载** (Download) to keep the article's records as Markdown.

Reload the article to check that your annotation returns. Pin ContextFlow from Chrome's puzzle-piece menu for easier access.

<img src="./assets/readme/reading-preview.png" alt="Actual reading UI: source highlighting, a personal annotation, and Markdown export" width="100%">

<sub>Preview of the v0.3.2 development UI. Core annotations and export are also available in the current v0.3.1 trial package.</sub>

## Choose what to enable next

| What you want | What you need |
| --- | --- |
| Highlights, annotations, pasted images, Markdown copy/download | Extension only |
| Automatic sync to Obsidian, a Markdown folder, or SiYuan | Local companion service and an output destination; AI is optional |
| AI translation, explanations, article overviews | Local service and your own model configuration |
| Answers grounded in personal notes | A local agent and explicit permission to read a notes directory |

### Connect the optional companion

Download **contextflow-companion-0.3.1.zip** from the release page. This is the local service, not the Chrome extension.

Install [Node.js 22.5 or later](https://nodejs.org/en/download), open a terminal in the extracted companion folder, and run:

~~~bash
npm ci --omit=dev
npm run server
~~~

Keep that terminal running. Open ContextFlow's **Extension options**, copy its pairing command, and run it in a second terminal in the same folder. Paste the generated code into the extension's own page and verify the connection.

Refresh the article. Open **配置** (Settings) in the reading panel:

- For note sync, select a Markdown folder, Obsidian vault, or SiYuan destination, save, and click **同步** (Sync).
- For AI, configure your own provider, model, and API key. Test a short passage with **解释** (Explain).
- Enable a local agent and a notes directory later if you want personal context.

The pairing code authorizes this extension to access your own local service. It is not a model API key. Model usage may incur charges; ContextFlow includes no free model allowance. Opening the reading panel can trigger an AI overview once configured.

## Data and privacy

Reading records and images live in extension-private storage. The optional companion stores data locally and writes notes to your chosen destination. There is no developer-hosted reading-history account.

AI requests may send article content, questions, and authorized note excerpts to services you configure. Local-first does not mean every AI request runs offline. [Privacy policy](https://pengheliu.github.io/ContextFlow/privacy.html).

Export or sync regularly. Uninstalling the extension removes its browser data, but not exported files, the companion database, or synced notes. Export/sync old development-build records before upgrading: old page-owned caches are not imported automatically.

## If something does not work

- No toolbar after installation: refresh the article. Chrome internal pages, Web Store pages, and the built-in PDF viewer are unsupported.
- No `npm` command: install Node.js and reopen your terminal.
- Missing `package.json`: run the command inside the extracted companion folder.
- Connection fails: keep the server terminal open, use the pairing command from your installed extension, and generate a new code if the old one was revoked.
- No AI answer: verify the provider, model, API key, and any local agent's login. Offline annotations still work.

macOS can optionally use `npm run service` for a login service. Windows/Linux currently use foreground `npm run server`; unattended installation has not been validated.

[Detailed setup guide (Chinese)](./docs/GETTING_STARTED.md) · [Report an issue](https://github.com/PengheLiu/ContextFlow/issues)

## The longer-term idea

Keep what you thought before available while you read something new: compare earlier definitions, surface conflicting evidence, and return unfinished questions to the page. Your notes remain ordinary, portable Markdown.

For source builds and release tooling, see the [development guide](./docs/DEVELOPMENT.md). Architecture and security decisions are documented in [DESIGN.md](./DESIGN.md).

MIT License · Local-first
