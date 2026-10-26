// Real content-script acceptance for a client-rendered site. Every browser,
// article, extension database and build below belongs to this temporary run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to a runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = join(root, 'release/product-evidence/product-1-1');
mkdirSync(evidence, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-spa-browser-'));
const config = join(temporary, 'empty-config'); mkdirSync(config);
const extension = join(temporary, 'extension');
const unexpectedServiceRequests = [];
const fixture = createServer((request, response) => {
  if (request.url.startsWith('/isolated-service/')) {
    unexpectedServiceRequests.push(request.url);
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'The isolated service fixture was not mocked.' }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html style="margin-right:17px;transition:color 0.25s linear"><head><meta charset="utf-8"><title>SPA Article A</title>
  <style>html{background:#fff;color:#242424}body{font:18px/1.8 system-ui;margin:50px;max-width:850px}h1{font:600 36px/1.4 Georgia,serif}p{margin:24px 0}article{min-height:900px}</style></head><body><main><article id="reading"></article></main>
  <script>
    function articleName(){const route=location.hash.startsWith('#/')?location.hash.slice(1):location.pathname;return route.split('/').filter(Boolean).at(-1)||'A';}
    function renderArticle(){const name=articleName();document.title='SPA Article '+name;document.querySelector('#reading').innerHTML='<h1>SPA Article '+name+'</h1><p id="selection">Article '+name+' discusses a distinct research result and keeps its own reading notes.</p><p>Switching articles updates this document without reloading the browser. The reading record must stay attached to the article where it was created.</p>';}
    window.fixtureNavigate=(name,mode='push',hash=false)=>{history[mode==='replace'?'replaceState':'pushState']({name},'',hash?'/reader#/'+name:'/article/'+name);renderArticle();};
    addEventListener('popstate',renderArticle);addEventListener('hashchange',renderArticle);renderArticle();
  </script></body></html>`);
});

let context, page;
const errors = [];
const waitFor = async (read, predicate, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 50));
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
};

try {
  await new Promise(ready => fixture.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    cwd: root, env: { ...process.env, CONTEXTFLOW_DIR: config, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe',
  });
  // Even if the isolated worker restarts during a mock, its only service URL is
  // this run's random fixture port. It cannot reach an installed companion.
  const workerPath = join(extension, 'sw.js'), workerSource = readFileSync(workerPath, 'utf8');
  assert.ok(workerSource.includes('http://127.0.0.1:7317'));
  writeFileSync(workerPath, workerSource.replaceAll('http://127.0.0.1:7317', `${base}/isolated-service`));
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
    headless: true, viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith('chrome-extension://') });
  const extensionId = new URL(worker.url()).hostname;
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('connection'))).connection, undefined, 'new profile has no real pairing credential');
  // No pairing credentials exist. An accidental localhost request is a test
  // failure, and the network boundary also blocks it before a user service.
  const serviceRequests = [];
  await context.route('http://127.0.0.1:7317/**', route => { serviceRequests.push(route.request().url()); return route.abort(); });
  const events = () => worker.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('contextflow-offline');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('events').objectStore('events').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result.filter(event => !event.deletedAt)); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }));
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/article/A`);
  const panel = () => page.locator('[data-contextflow="panel"]');
  await panel().waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await panel().locator('#wrap').waitFor({ state: 'visible' });

  const shape = () => page.evaluate(() => ({
    panels: document.querySelectorAll('[data-contextflow="panel"]').length,
    toolbars: document.querySelectorAll('[data-contextflow="toolbar"]').length,
    commentEditors: document.querySelectorAll('[data-contextflow="tip-comment"]').length,
    margin: document.documentElement.style.marginRight,
    transition: document.documentElement.style.transition,
    selection: document.querySelector('#selection').textContent,
  }));
  const assertSingleUI = async () => {
    const state = await shape();
    assert.equal(state.panels, 1, 'one current panel');
    assert.equal(state.toolbars, 1, 'one current selection toolbar');
    assert.ok(state.commentEditors <= 1, 'obsolete comment editors are removed');
  };
  const navigate = async (name, mode = 'push', hash = false, open = true) => {
    await page.evaluate(({ name, mode, hash }) => {
      window.previousContextFlowPanel = document.querySelector('[data-contextflow="panel"]');
      window.fixtureNavigate(name, mode, hash);
    }, { name, mode, hash });
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-contextflow="panel"]');
      return host && host !== window.previousContextFlowPanel && !window.previousContextFlowPanel?.isConnected;
    });
    await panel().locator('#wrap').waitFor({ state: open ? 'visible' : 'hidden' });
    await assertSingleUI();
  };
  const startComment = async value => {
    await page.locator('#selection').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.getByRole('button', { name: '批注', exact: true }).click();
    const editor = page.locator('[data-contextflow="tip-comment"] textarea');
    await editor.fill(value);
    assert.equal(await editor.evaluate(element => element.getRootNode().activeElement === element), true, 'latest input is still focused and has not blurred');
  };
  const comments = () => events().then(rows => rows.filter(row => row.action === 'comment'));
  const panelContent = () => panel().locator('#wrap').evaluate(wrap => `${wrap.innerText}\n${[...wrap.querySelectorAll('textarea')].map(editor => editor.value).join('\n')}`);
  const aValue = 'A_ONLY latest unblurred sentence — 只属于文章 A。';
  const bValue = 'B_ONLY 独立批注，不能继承文章 A 的内容。';

  await startComment(aValue);
  // No clicking, blur, debounce wait or explicit Save before History API change.
  await navigate('B');
  await waitFor(comments, rows => rows.some(row => row.value === aValue), 'A latest input is durable before it retires');
  await startComment(bValue);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const first = await waitFor(comments, rows => rows.length === 2 && rows.some(row => row.value === bValue), 'two article comments saved');
  const a = first.find(row => row.value === aValue), b = first.find(row => row.value === bValue);
  assert.equal(a.urlKey, `${base}/article/A`); assert.equal(a.url, `${base}/article/A`);
  assert.equal(b.urlKey, `${base}/article/B`); assert.equal(b.url, `${base}/article/B`);
  assert.equal(a.title, 'SPA Article A'); assert.equal(b.title, 'SPA Article B');
  assert.match(a.text, /^Article A /); assert.match(b.text, /^Article B /);
  assert.notEqual(a.id, b.id);
  await page.screenshot({ path: join(evidence, 'spa-b-independent-comment.png'), fullPage: true });

  const library = await context.newPage();
  library.on('pageerror', error => errors.push(`library: ${error.message}`));
  await library.goto(`chrome-extension://${extensionId}/options.html#library`);
  await library.locator('#reading-library #library-stats').waitFor({ state: 'attached' });
  const firstRecordCount = (await events()).length; // Each comment also has a parent source/highlight record.
  await waitFor(() => library.locator('#reading-library #library-stats').textContent(), text => text === `2 篇文章 · ${firstRecordCount} 条已保存记录`, 'reading library has two saved articles');
  assert.equal(await library.locator('.article-button').count(), 2);
  for (const [title, own, other] of [['SPA Article A', aValue, bValue], ['SPA Article B', bValue, aValue]]) {
    await library.locator('.article-button').filter({ has: library.locator('.article-title', { hasText: title }) }).click();
    await library.locator('#library-preview-title').filter({ hasText: title }).waitFor();
    const text = await library.locator('#library-preview-body').innerText();
    assert.ok(text.includes(own), `${title} preview includes its own comment`);
    assert.ok(!text.includes(other), `${title} preview excludes the other article's comment`);
  }
  await library.screenshot({ path: join(evidence, 'spa-reading-library-two-articles.png'), fullPage: true });
  console.log('ok SPA A 未失焦最后输入 → pushState B → B 批注；真实 IDB 与阅读库保持 2 篇独立文章');

  await page.bringToFront();
  await page.evaluate(() => { window.previousContextFlowPanel = document.querySelector('[data-contextflow="panel"]'); history.back(); });
  await page.waitForFunction(() => location.pathname.endsWith('/A') && document.querySelector('[data-contextflow="panel"]') !== window.previousContextFlowPanel && !window.previousContextFlowPanel?.isConnected);
  await panel().locator('#wrap').waitFor({ state: 'visible' });
  await waitFor(panelContent, text => text.includes(aValue), 'back restores A comment');
  assert.ok(!(await panelContent()).includes(bValue), 'back does not include B comment');
  await navigate('C', 'replace');
  assert.equal((await comments()).length, 2, 'replaceState itself does not create reading records');
  assert.ok(!(await panelContent()).includes(aValue), 'new C panel has no A comment');
  assert.ok(!(await panelContent()).includes(bValue), 'new C panel has no B comment');

  // Snapshot native document/window event listeners, including the extension's
  // isolated world, through Chromium DevTools rather than page monkey-patches.
  const cdp = await context.newCDPSession(page);
  const executionContexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => executionContexts.push(context));
  await cdp.send('Runtime.enable');
  const isolatedWorld = executionContexts.find(world => world.origin === `chrome-extension://${extensionId}` || world.name.includes(extensionId));
  assert.ok(isolatedWorld, `extension isolated world is observable: ${JSON.stringify(executionContexts)}`);
  const listenerCounts = async () => {
    const counts = {};
    for (const target of ['document', 'window']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: target, contextId: isolatedWorld.id });
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 1 });
      for (const listener of listeners) {
        const key = `${target}:${listener.type}:${listener.useCapture}`;
        counts[key] = (counts[key] || 0) + 1;
      }
      await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    }
    return counts;
  };
  const before = await listenerCounts(), openMargin = (await shape()).margin;
  assert.ok(Object.keys(before).some(key => key.startsWith('document:mouseup:')), 'CDP listener snapshot includes the content script isolated world');
  for (const name of ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C']) {
    await navigate(name);
    assert.equal((await shape()).margin, openMargin, 'panel margin does not accumulate across route changes');
  }
  assert.deepEqual(await listenerCounts(), before, 'document/window global listeners do not accumulate across article sessions');
  assert.equal((await comments()).length, 2, 'revisiting cached sessions does not duplicate records');
  await page.evaluate(() => {
    window.previousContextFlowPanel = document.querySelector('[data-contextflow="panel"]');
    window.fixtureNavigate('A'); window.fixtureNavigate('B'); window.fixtureNavigate('BurstC');
  });
  await page.waitForFunction(() => document.title === 'SPA Article BurstC' && document.querySelector('[data-contextflow="panel"]') !== window.previousContextFlowPanel && !window.previousContextFlowPanel?.isConnected);
  await panel().locator('#wrap').waitFor({ state: 'visible' });
  await assertSingleUI();
  assert.deepEqual(await listenerCounts(), before, 'rapid same-task A/B/C history changes leave only the latest session listeners');

  // Plain anchors stay in the current article. Hash routes identify new ones.
  await page.evaluate(() => { window.previousContextFlowPanel = document.querySelector('[data-contextflow="panel"]'); location.hash = 'section-two'; });
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => document.querySelector('[data-contextflow="panel"]') === window.previousContextFlowPanel), true, 'ordinary anchor preserves current article UI');
  await navigate('HashA', 'push', true);
  await startComment('HASH_A_ONLY — hash router article');
  await navigate('HashB', 'push', true);
  const hashRows = await waitFor(comments, rows => rows.some(row => row.value.startsWith('HASH_A_ONLY')), 'hash router input survives navigation');
  const hashA = hashRows.find(row => row.value.startsWith('HASH_A_ONLY'));
  assert.equal(hashA.urlKey, `${base}/reader#/HashA`);
  assert.equal(hashA.url, `${base}/reader#/HashA`);
  assert.equal(hashA.title, 'SPA Article HashA');
  assert.ok(!(await panelContent()).includes('HASH_A_ONLY'), 'hash router B excludes hash router A comment');
  await assertSingleUI();

  await page.getByRole('button', { name: '收起 ContextFlow', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.style.marginRight === '17px');
  await page.waitForFunction(() => document.documentElement.style.transition === 'color 0.25s linear');
  await navigate('A', 'push', false, false);
  assert.equal((await shape()).margin, '17px', 'navigation preserves the original page margin while panel is closed');

  // Hold only the test profile's assets store. This exercises a real pasted
  // PNG whose durable write is pending, without delaying or mocking UI code.
  await navigate('ImageA', 'push', false, false);
  await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await startComment('PENDING_IMAGE_ONLY — belongs to ImageA');
  await worker.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('contextflow-offline');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('assets', 'readwrite'), store = tx.objectStore('assets');
      const deadline = Date.now() + 10000; let released = false;
      globalThis.releaseSpaAssetWrite = () => { released = true; };
      tx.oncomplete = tx.onabort = () => db.close();
      const hold = () => { const read = store.get('__spa_pending_asset__'); read.onsuccess = () => { if (!released && Date.now() < deadline) hold(); }; };
      hold(); resolve(true);
    };
  }));
  await page.locator('[data-contextflow="tip-comment"] textarea').evaluate(editor => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII='), character => character.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'spa-fixture.png', { type: 'image/png' }));
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.locator('[data-contextflow="tip-comment"] .rc.busy').waitFor();
  assert.match(await page.locator('[data-contextflow="tip-comment"] #state').textContent(), /正在保存图片/);
  assert.equal(await page.locator('[data-contextflow="tip-comment"] #done').isDisabled(), true, 'pending image cannot be marked complete');
  await page.evaluate(() => { window.previousContextFlowPanel = document.querySelector('[data-contextflow="panel"]'); window.fixtureNavigate('ImageB'); });
  await page.locator('[data-contextflow="article-transition"] #route-notice').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('[data-contextflow="panel"]') === window.previousContextFlowPanel), true, 'pending image keeps its original editor alive');
  await page.screenshot({ path: join(evidence, 'spa-pending-image-navigation-protection.png'), fullPage: true });
  await worker.evaluate(() => globalThis.releaseSpaAssetWrite());
  await page.waitForFunction(() => document.querySelector('[data-contextflow="panel"]') !== window.previousContextFlowPanel && !window.previousContextFlowPanel?.isConnected);
  const imageRows = await waitFor(comments, rows => rows.some(row => row.value?.includes('PENDING_IMAGE_ONLY') && row.value.includes('contextflow-asset:')), 'completed pasted image remains attached to ImageA comment');
  const imageComment = imageRows.find(row => row.value?.includes('PENDING_IMAGE_ONLY'));
  assert.equal(imageComment.urlKey, `${base}/article/ImageA`); assert.equal(imageComment.title, 'SPA Article ImageA');
  assert.ok(!(await panelContent()).includes('PENDING_IMAGE_ONLY'), 'ImageB excludes ImageA draft after image finishes');
  assert.equal(await page.locator('[data-contextflow="article-transition"]').count(), 0, 'saved image clears the navigation recovery notice');
  await assertSingleUI();
  await page.getByRole('button', { name: '收起 ContextFlow', exact: true }).click();
  await navigate('A', 'push', false, false);
  console.log('ok 真实 PNG 粘贴的私有 IDB 写入挂起时保留原编辑器并提示；完成后自动切页，图文仍属于原文章');

  // A real content-script request waits on a synthetic upstream response in
  // this test worker. Navigating does not cancel the old article's answer, and
  // completion cannot append it to or mutate the visible article's UI.
  await worker.evaluate(async initialEvents => {
    const rows = new Map(initialEvents.map(event => [event.id, event]));
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(url), path = target.pathname.replace(/^\/isolated-service/, '');
      const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/health') return json({ ok: true, extensionPaired: true, serviceVersion: 'fixture', capabilities: ['llm.draft'], llmConfigured: true, explainConfigured: true });
      if (path === '/events') {
        if (init.method === 'POST') {
          for (const event of JSON.parse(init.body).events) rows.set(event.id, event);
          return json({ ok: true });
        }
        return json({ events: [...rows.values()].filter(event => event.urlKey === target.searchParams.get('urlKey')) });
      }
      if (path === '/article') return json({ changed: true, chars: JSON.parse(init.body).text.length });
      if (path === '/assets' && init.method === 'POST') return json({ asset: { id: JSON.parse(init.body).id } });
      if (path === '/explain') return new Promise(resolve => {
        globalThis.spaPendingExplain = { body: JSON.parse(init.body), release: () => resolve(json({ answer: 'LATE_AI_A_ONLY — original article answer', model: 'isolated-fixture' })) };
      });
      throw new Error(`Unmocked isolated upstream ${path}`);
    };
    await chrome.storage.local.set({ connection: { token: 'isolated-spa-fixture-only', source: 'companion' } });
  }, await events());
  await library.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'cf-configuration-changed' }, resolve)));
  await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await page.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '解释', exact: true }).click();
  await page.locator('[data-contextflow="tip-explain"] #q').fill('LATE_AI_QUESTION_A');
  await page.locator('[data-contextflow="tip-explain"] #go').click();
  await waitFor(() => worker.evaluate(() => globalThis.spaPendingExplain?.body || null), value => value?.urlKey === `${base}/article/A`, 'A explanation request waits on isolated upstream');
  await navigate('B');
  const bMargin = (await shape()).margin;
  await worker.evaluate(() => globalThis.spaPendingExplain.release());
  const completed = await waitFor(events, rows => rows.some(row => row.action === 'explain' && row.value?.startsWith('LATE_AI_A_ONLY')), 'late A answer saved in the private extension database');
  const answer = completed.find(row => row.action === 'explain' && row.value?.startsWith('LATE_AI_A_ONLY'));
  assert.equal(answer.urlKey, `${base}/article/A`); assert.equal(answer.url, `${base}/article/A`); assert.equal(answer.title, 'SPA Article A');
  assert.ok(!(await panelContent()).includes('LATE_AI_A_ONLY'), 'late A answer does not appear in B panel');
  assert.equal((await shape()).margin, bMargin, 'late A completion does not restore old layout');
  assert.equal(await page.locator('[data-contextflow="tip-explain"]').count(), 0, 'late A completion does not reopen an obsolete popover');
  await assertSingleUI();
  await page.screenshot({ path: join(evidence, 'spa-late-ai-stays-with-original-article.png'), fullPage: true });
  await library.locator('#library-refresh').click();
  await library.locator('.article-button').filter({ has: library.locator('.article-title', { hasText: 'SPA Article A' }) }).click();
  await waitFor(() => library.locator('#library-preview-body').innerText(), text => text.includes('LATE_AI_A_ONLY'), 'reading library original A includes its late answer');
  console.log('ok 原文章 AI 请求挂起 → 导航到 B → A 晚到回答只保存到 A；B 面板、margin、宿主不受影响，未调用真实模型');
  assert.deepEqual(errors, [], 'reading pages and library have no uncaught errors');
  assert.deepEqual(serviceRequests, [], 'unpaired test did not contact a personal service');
  assert.deepEqual(unexpectedServiceRequests, [], 'all paired requests used the pure upstream fixture');
  rmSync(join(evidence, 'spa-failure.png'), { force: true });
  console.log(`ok back/replaceState/普通锚点/hash router/连续 A B C 切换、单宿主、页面 margin 与全局监听稳定；Chromium ${context.browser().version()}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'spa-failure.png'), fullPage: true }).catch(() => {});
    console.error('SPA diagnostic:', await page.evaluate(() => ({ url: location.href, title: document.title, hosts: [...document.querySelectorAll('[data-contextflow]')].map(host => host.dataset.contextflow) })).catch(() => ({})));
  }
  throw error;
} finally {
  await context?.close();
  await new Promise(done => fixture.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
