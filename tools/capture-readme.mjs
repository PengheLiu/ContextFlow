// Capture real extension UI on original sample text, using an isolated profile.
// Usage: CONTEXTFLOW_PLAYWRIGHT_DIR=/path/to/runtime node tools/capture-readme.mjs
// CONTEXTFLOW_CHROMIUM_PATH may override Playwright's bundled Chromium.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to a runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-readme-'));
const extension = join(temporary, 'extension');
const fixture = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(readFileSync(join(root, 'assets/readme/reading-article.html')));
});
let context;

try {
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    cwd: root,
    env: { ...process.env, CONTEXTFLOW_EXT_DIR: extension },
    stdio: 'pipe',
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium',
    executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
    headless: true,
    viewport: { width: 1440, height: 920 },
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  const ready = page.waitForEvent('console', { predicate: (message) => message.text().includes('[ContextFlow] 就绪') });
  await page.goto(`http://127.0.0.1:${fixture.address().port}/reading`);
  await ready;
  await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await page.locator('#selection').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '批注', exact: true }).click();
  const thought = '以后读研究报告，除了记结论，也要记下：\n它的证据是什么？哪些前提还需要验证？';
  await page.locator('[data-contextflow="tip-comment"] textarea').fill(thought);
  await page.getByRole('status').filter({ hasText: '已保存并同步' }).waitFor();
  const mirrored = page.locator('[data-contextflow="panel"] textarea').filter({ visible: true });
  assert.ok((await mirrored.allTextContents()).length > 0);
  await page.waitForFunction((value) => [...document.querySelector('[data-contextflow="panel"]').shadowRoot.querySelectorAll('textarea')]
    .some((element) => element.value === value), thought);
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-contextflow="panel"]').shadowRoot.getElementById('wrap').getBoundingClientRect();
    return Math.abs(rect.right - innerWidth) < 1;
  });
  await page.screenshot({ path: join(root, 'assets/readme/inline-annotation.png') });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const markdown = readFileSync(await (await download).path(), 'utf8');
  assert.ok(markdown.includes(thought.split('\n')[0]));
  assert.ok(markdown.includes('值得保存的不只是原文'));
  console.log('Captured real inline editor + mirrored side panel; verified Markdown export.');
} finally {
  if (context) await context.close();
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
