// Actual Chromium loading is different from injecting the UI into a web page:
// the extension loader rejects Unicode noncharacters before JS can run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to a runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-extension-load-'));
const config = join(temporary, 'empty-config'); mkdirSync(config);
const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>Extension loading fixture</title><h1>Brier loss</h1><p>A squared probability error.</p>');
});
let context;
try {
  await new Promise(ready => fixture.listen(0, '127.0.0.1', ready));
  for (const mode of ['development', 'store']) {
    const extension = join(temporary, mode);
    execFileSync(process.execPath, ['tools/build.mjs', '--ext', ...(mode === 'store' ? ['--store'] : [])], {
      cwd: root, env: { ...process.env, CONTEXTFLOW_DIR: config, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe',
    });
    context = await chromium.launchPersistentContext(join(temporary, `${mode}-profile`), {
      channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
      headless: true, viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(10000);
    const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith('chrome-extension://'), timeout: 10000 });
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${fixture.address().port}/reading`);
    await page.locator('[data-contextflow="panel"]').waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
    assert.equal(await page.locator('[data-contextflow="panel"]').locator('#wrap').isVisible(), true);
    assert.deepEqual(errors, [], `${mode} content script errors`);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#welcome-title').waitFor();
    assert.equal(await options.evaluate(() => chrome.runtime.id), id);
    console.log(`${mode}: Chromium ${context.browser().version()} 实际加载成功；service worker、阅读页 content script、设置页均通过`);
    await context.close(); context = null;
  }
} finally {
  await context?.close();
  await new Promise(done => fixture.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
