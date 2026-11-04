// Fresh packaged extension, real worker/RPC/content script/options UI. Only the
// official public version response is simulated; every other worker fetch is
// rejected. This disposable browser never reaches a service, model or account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { UPDATE_FEED_URL, UPDATE_DOWNLOAD_URL, UPDATE_STORE_URL } from '../src/core/updates.js';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to the runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-update-browser-'));
const config = join(temporary, 'empty-config'), extension = join(temporary, 'extension');
const evidence = join(root, 'release/product-evidence/extension-updates');
mkdirSync(config); mkdirSync(evidence, { recursive: true });
const notes = version => `https://github.com/PengheLiu/ContextFlow/releases/tag/v${version}`;
const feed = { schemaVersion: 1, extension: { version: '1.2.0', url: UPDATE_STORE_URL, releaseNotesUrl: notes('1.2.0') },
  desktop: { 'darwin-arm64': { version: '1.1.2', url: UPDATE_DOWNLOAD_URL, releaseNotesUrl: notes('1.1.2') } } };
const draft = '正在编辑的批注：请保留这段文字，再查看更新方式。';
const errors = [], outsideRequests = [], layouts = [];
let context;
const fixture = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Update notice fixture</title>
    <style>body{font:18px/1.7 system-ui;margin:28px;max-width:850px;overflow-wrap:anywhere}textarea{width:220px;max-width:100%}</style>
    <h1>Keep reading while an update is available</h1>
    <p id="selection">A useful update keeps your thoughts where you left them.</p>
    <textarea id="host-draft">HOST_OWNED_UNSAVED_DRAFT</textarea>
    <script>window.fixtureIdentity=Math.random();</script>`);
});
const waitFor = async (read, predicate, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 40));
  } while (Date.now() < end);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
};

try {
  await new Promise(done => fixture.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], { cwd: root,
    env: { ...process.env, CONTEXTFLOW_DIR: config, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe' });
  const version = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version;
  const workerFile = join(extension, 'sw.js');
  const intercept = `globalThis.__publicUpdateRequests=[];globalThis.__blockedWorkerFetches=[];
    globalThis.fetch=async(input,init={})=>{const url=String(input?.url||input);
      if(url===${JSON.stringify(UPDATE_FEED_URL)}){globalThis.__publicUpdateRequests.push({url,credentials:init.credentials,hasBody:!!init.body,hasAuthorization:new Headers(init.headers||{}).has('authorization')});
        return new Response(${JSON.stringify(JSON.stringify(feed))},{status:200,headers:{'Content-Type':'application/json'}});}
      globalThis.__blockedWorkerFetches.push(url);throw new Error('Isolated browser refuses external/service fetch');};\n`;
  writeFileSync(workerFile, intercept + readFileSync(workerFile, 'utf8'));
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
    headless: true, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  await context.route(/^https?:\/\//, route => {
    if (route.request().url().startsWith(base + '/')) return route.continue();
    outsideRequests.push(route.request().url()); return route.abort();
  });
  const worker = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { predicate: value => value.url().startsWith('chrome-extension://') });
  const extensionId = new URL(worker.url()).hostname;
  const article = await context.newPage(); article.on('pageerror', error => errors.push(error.message));
  await article.goto(`${base}/article`);
  const panel = article.locator('[data-contextflow="panel"]');
  await panel.waitFor({ state: 'attached' });
  await article.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  const update = panel.locator('#update');
  await update.waitFor({ state: 'visible' });
  assert.match(await update.getAttribute('aria-label'), /1\.2\.0/);
  await article.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.getByRole('button', { name: '批注', exact: true }).click();
  const comment = article.locator('[data-contextflow="tip-comment"] textarea');
  await comment.fill(draft);
  const before = await article.evaluate(() => ({ identity: window.fixtureIdentity, url: location.href, hostDraft: document.getElementById('host-draft').value }));
  const opened = context.waitForEvent('page');
  await update.click();
  const options = await opened;
  options.on('pageerror', error => errors.push(error.message));
  await options.waitForURL(`chrome-extension://${extensionId}/options.html#updates`);
  await options.locator('#updates').waitFor({ state: 'visible' });
  await waitFor(() => options.locator('#update-latest').textContent(), value => value === 'v1.2.0', 'options must read the real worker update RPC');
  assert.equal(await options.locator('#update-current').textContent(), `v${version}`);
  await waitFor(() => options.locator('#update-message').textContent(), value => /开发版/.test(value), 'unpacked test copy must not promise store auto-update');
  assert.match(await options.locator('#update-install-help').textContent(), /开发版.*Chrome 商店不会替换/);
  assert.equal(await options.locator('#update-manage').isVisible(), false);
  assert.equal(await options.locator('#update-indicator').isVisible(), true);
  await options.locator('#check-updates').click();
  await waitFor(() => worker.evaluate(() => globalThis.__publicUpdateRequests.length), value => value >= 2, 'explicit check must fetch the public feed again');
  await options.locator('#check-updates:not([disabled])').waitFor();
  assert.equal(await comment.inputValue(), draft);
  assert.deepEqual(await article.evaluate(() => ({ identity: window.fixtureIdentity, url: location.href, hostDraft: document.getElementById('host-draft').value })), before,
    'opening/rechecking updates cannot refresh the article, replace the draft or edit a host form');

  for (const scheme of ['light', 'dark']) {
    await article.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 260]) {
      await article.setViewportSize({ width: 1280, height: 900 });
      await panel.locator('#grab').press(width === 260 ? 'Home' : 'Enter');
      await waitFor(() => panel.locator('#wrap').evaluate(element => Math.round(element.getBoundingClientRect().width)), value => value === width, 'panel resize');
      const metrics = await panel.evaluate(host => {
        const sh = host.shadowRoot, wrap = sh.getElementById('wrap'), action = sh.getElementById('update');
        const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const buttons = [...sh.querySelectorAll('.title button')].filter(button => !button.hidden).map(box);
        const brand = box(sh.querySelector('.brand')), actions = box(sh.querySelector('.title .r'));
        return { width: wrap.clientWidth, brand, actions, buttons, update: box(action) };
      });
      await article.screenshot({ path: join(evidence, `panel-${width}-${scheme}.png`) });
      // Hidden absolute tooltips intentionally have their own intrinsic width;
      // use the actual document and visible header hit areas for overflow QA.
      assert.equal(await article.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `panel ${width}/${scheme} must not cause document overflow`);
      assert.ok(metrics.brand.left >= 1280 - width && metrics.actions.right <= 1280, 'visible header stays within the panel');
      assert.ok(metrics.brand.right <= metrics.actions.left + 1, `panel ${width}/${scheme} brand cannot overlap header actions`);
      for (let i = 1; i < metrics.buttons.length; i++) assert.ok(metrics.buttons[i - 1].right <= metrics.buttons[i].left + 1, 'header action hit areas must not overlap');
      assert.ok(metrics.update.left >= 0 && metrics.update.right <= 1280);
      layouts.push({ surface: 'panel', width, scheme, passed: true });
    }
    await article.setViewportSize({ width: 390, height: 844 });
    await update.waitFor({ state: 'visible' });
    assert.equal(await article.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile article does not gain horizontal overflow');
    await article.screenshot({ path: join(evidence, `panel-390-${scheme}.png`) });
    await options.emulateMedia({ colorScheme: scheme });
    await options.setViewportSize({ width: 390, height: 844 });
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile update options do not overflow');
    await options.locator('#check-updates').scrollIntoViewIfNeeded();
    assert.equal(await options.locator('#check-updates').isVisible(), true);
    await options.screenshot({ path: join(evidence, `options-390-${scheme}.png`), fullPage: true });
    layouts.push({ surface: 'article-and-options', viewport: 390, scheme, passed: true });
  }
  const requests = await worker.evaluate(() => ({ public: globalThis.__publicUpdateRequests, blocked: globalThis.__blockedWorkerFetches }));
  assert.ok(requests.public.length >= 2);
  for (const request of requests.public) {
    assert.equal(request.url, UPDATE_FEED_URL); assert.equal(request.credentials, 'omit');
    assert.equal(request.hasBody, false); assert.equal(request.hasAuthorization, false);
  }
  assert.deepEqual(outsideRequests, []); assert.deepEqual(errors, []);
  const report = { format: 'ContextFlowUpdatesBrowser', version, extensionId, actualWorkerRpc: true,
    articleDraftPreserved: true, articleAutomaticallyRefreshed: false, honestDevelopmentGuidance: true,
    explicitCheckVerified: true, publicRequests: requests.public.length, blockedWorkerRequests: requests.blocked.length,
    realServiceRequests: 0, realModelCalls: 0, errors, layouts };
  writeFileSync(join(evidence, 'update-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await context?.close();
  await new Promise(done => fixture.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
