// Release acceptance runs the submitted ZIP, never extension/dist or a rebuild.
// No OS Native Messaging registration, installed desktop or personal Chrome
// profile is used. The worker's connectNative transport alone is substituted;
// the unmodified worker makes authenticated HTTP requests to a real temp core
// through an isolated forward proxy (the product's fixed port stays untouched).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pairExtension } from '../server/extension-pairing.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to an existing Playwright runtime.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const zip = resolve(process.env.CONTEXTFLOW_STORE_ZIP || join(root, 'release/contextflow-chrome-1.1.0.zip'));
const sha = value => createHash('sha256').update(value).digest('hex');
const zipHash = sha(readFileSync(zip));
const temporary = mkdtempSync(join(tmpdir(), 'cf-store-artifact-'));
const extension = join(temporary, 'extension'), config = join(temporary, 'config');
mkdirSync(extension); mkdirSync(config);
const id = 'aemncphfnlpbhlddifhohpgegejjejfm';
// This deliberately non-loopback HTTP origin is NOT a secure context. A
// localhost fixture would conceal randomUUID/subtle availability regressions.
const base = 'http://127.0.0.1:7317', articleUrl = 'http://artifact-fixture.invalid/reading';
const note = '最终商店包首次批注：刷新后也要保留。';
const key = 'isolated-model-key-do-not-render';
const md = String.raw`布里尔损失

\[
L_{\text{Brier}}=(q-c)^2
\]

行内 \(q\) 与 $c$。

- 第一项 **重点**
- 第二项

| 指标 | 值 |
| --- | --- |
| Brier | $q^2$ |

<img src=x onerror="window.markdownExecuted=true">
`;
let context, service, proxy, article;
const logs = [], pageErrors = [], coreRequests = [], proxySocketErrors = [];
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
};
const send = (page, message) => page.evaluate(message => chrome.runtime.sendMessage(message), message);
try {
  const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.every(name => !name.startsWith('/') && !name.split('/').includes('..')), 'unsafe ZIP path');
  execFileSync('unzip', ['-q', zip, '-d', extension]);
  const hashes = Object.fromEntries(files(extension).map(file => [relative(extension, file), sha(readFileSync(file))]));
  for (const name of ['app.js', 'sw.js', 'options.js', 'options.html']) assert.ok(hashes[name], `ZIP lacks ${name}`);
  const manifestFile = join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.version, process.env.CONTEXTFLOW_STORE_VERSION || '1.1.0');
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  // The public key only preserves the Web Store identity in an unpacked test.
  manifest.key = readFileSync(join(root, 'store/extension-key.pub'), 'utf8').trim();
  writeFileSync(manifestFile, JSON.stringify(manifest));

  const reservation = createServer(); await listen(reservation);
  const corePort = reservation.address().port; await new Promise(done => reservation.close(done));
  const adminToken = 'artifact-core-admin-only';
  writeFileSync(join(config, 'config.json'), JSON.stringify({ port: corePort, requireToken: true, token: adminToken,
    allowedOrigins: [], agent: { id: '' }, translate: { apiKey: key }, markdown: { dir: join(temporary, 'notes') } }));
  service = spawn(process.execPath, ['server/index.mjs'], { cwd: root,
    env: { ...process.env, CONTEXTFLOW_DIR: config, CONTEXTFLOW_DESKTOP_TOKEN: 'artifact-desktop-only',
      ANTHROPIC_API_KEY: '', PATH: join(temporary, 'no-agents') }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', chunk => logs.push(String(chunk))); service.stderr.on('data', chunk => logs.push(String(chunk)));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) throw new Error(`Isolated core exited: ${logs.join('').slice(-1000)}`);
    try {
      const health = await fetch(`http://127.0.0.1:${corePort}/health`, { headers: { 'X-ContextFlow': '1', Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(200) });
      if (health.ok) { ready = true; break; }
    } catch { /* own temporary service boot */ }
    await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(ready, 'isolated core did not become ready');
  proxy = createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (target.origin === base) {
      coreRequests.push({ path: target.pathname, extension: req.headers['x-contextflow-extension'],
        instance: req.headers['x-contextflow-instance'], authenticated: /^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization || '') });
      const forwarded = httpRequest({ host: '127.0.0.1', port: corePort, path: target.pathname + target.search, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${corePort}` } }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
      forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(forwarded); return;
    }
    if (target.origin === new URL(articleUrl).origin) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>最终商店包验收</title><style>body{margin:80px;max-width:760px;font:18px/1.8 sans-serif}article{padding-top:60px}</style><article><h1>Brier loss</h1><p id="selection">Reading should preserve your own understanding.</p><p>A squared probability error.</p></article>'); return;
    }
    res.writeHead(502).end(); // Never proxy to external hosts or user services.
  });
  proxy.on('connect', (_req, socket) => {
    // Chromium can reset a deliberately rejected background HTTPS tunnel.
    // CONNECT sockets leave the HTTP parser, so own their terminal errors;
    // unexpected transport failures still fail the acceptance assertions.
    socket.on('error', error => { if (!['ECONNRESET', 'EPIPE'].includes(error.code)) proxySocketErrors.push(error.code || error.name); });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await listen(proxy);
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
    headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`, '--proxy-bypass-list=<-loopback>'],
  });
  context.setDefaultTimeout(12000);
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { predicate: w => w.url().startsWith('chrome-extension://') });
  assert.equal(new URL(worker.url()).hostname, id);
  article = await context.newPage(); article.on('pageerror', error => pageErrors.push(error.message));
  article.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') logs.push(message.text()); });
  const readingReady = article.waitForEvent('console', { predicate: message => message.text().includes('[ContextFlow] 就绪') });
  await article.goto(articleUrl);
  await readingReady;
  assert.equal(await article.evaluate(() => isSecureContext), false, 'the HTTP regression fixture must remain an insecure context');
  await article.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.getByRole('button', { name: '批注', exact: true }).click();
  await article.locator('[data-contextflow="tip-comment"] textarea').fill(note);
  await article.getByRole('button', { name: '完成', exact: true }).click();
  await article.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await article.getByRole('tab', { name: /阅读记录/ }).click();
  await article.waitForFunction(note => [...(document.querySelector('[data-contextflow="panel"]')?.shadowRoot?.querySelectorAll('textarea') || [])].some(el => el.value === note), note);
  await article.reload();
  // A fresh document can be ready before its content-script storage restores.
  await article.waitForFunction(note => [...(document.querySelector('[data-contextflow="panel"]')?.shadowRoot?.querySelectorAll('textarea') || [])].some(el => el.value === note), note);
  assert.deepEqual(await article.evaluate(async () => ({ local: Object.keys(localStorage), databases: (await indexedDB.databases()).map(db => db.name) })), { local: [], databases: [] });
  const options = await context.newPage(); options.on('pageerror', error => pageErrors.push(error.message));
  await options.goto(`chrome-extension://${id}/options.html#library`);
  await options.locator('#reading-library #library-stats').filter({ hasText: '1 篇文章' }).waitFor();
  assert.match(await options.locator('#reading-library #library-preview-body').textContent(), new RegExp(note));
  const [download] = await Promise.all([options.waitForEvent('download'), options.getByRole('button', { name: '下载 Markdown', exact: true }).click()]);
  assert.ok(readFileSync(await download.path(), 'utf8').includes(note));
  const [backup] = await Promise.all([options.waitForEvent('download'), options.getByRole('button', { name: '下载完整备份', exact: true }).click()]);
  const savedHighlight = JSON.parse(readFileSync(await backup.path(), 'utf8')).events.find(event => event.action === 'highlight');
  assert.ok(savedHighlight?.anchor, 'first annotation must have a real source anchor');

  // Seed a prior AI answer through the real, user-facing backup import, not
  // private app internals. This exercises Markdown in library, list and popover.
  const fixture = { format: 'contextflow-reading-backup', version: 1, exportedAt: Date.now(), assets: [], events: [{
    id: 'artifact-formula', urlKey: articleUrl, url: articleUrl, title: '最终商店包验收', action: 'explain',
    text: savedHighlight.text, anchor: savedHighlight.anchor, value: md, createdAt: Date.now(), extra: { question: '解释这个 loss' },
  }] };
  await options.locator('#reading-library #library-file').setInputFiles({ name: 'isolated-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await options.getByRole('button', { name: '确认补充记录', exact: true }).click();
  await options.locator('#reading-library #library-notice').filter({ hasText: '补充 1 条' }).waitFor();
  const preview = options.locator('#reading-library #library-preview-body');
  await preview.locator('.md-math-display math').waitFor();
  assert.ok(await preview.locator('.md-math-inline math').count());
  assert.equal(await preview.locator('li').filter({ hasText: /^第一项 重点$/ }).count(), 1);
  assert.equal(await preview.locator('li').filter({ hasText: /^第二项$/ }).count(), 1);
  assert.equal(await preview.locator('table').count(), 1);
  assert.equal(await preview.locator('img,script').count(), 0);
  await article.reload(); await article.getByRole('tab', { name: /阅读记录/ }).click();
  const record = article.locator('[data-contextflow="panel"] [data-id="artifact-formula"]');
  await record.waitFor();
  if (await record.locator('.answer-details').getAttribute('open') === null) await record.locator('.answer-details > summary').click();
  await record.locator('.ans .md-math-display math').waitFor();
  assert.equal(await record.locator('.ans li').count(), 2);
  await record.getByRole('button', { name: '原位查看并追问', exact: true }).click();
  await article.locator('[data-contextflow="tip-explain"] #b .md-math-display math').waitFor();
  assert.equal(await article.locator('[data-contextflow="tip-explain"] #b li').count(), 2);
  assert.equal(await article.evaluate(() => window.markdownExecuted), undefined);
  console.log('ok Final ZIP: first annotation, refresh recovery, private storage, reading library/export and Markdown math/list/table in 3 surfaces');

  await options.goto(`chrome-extension://${id}/options.html#connect`);
  await options.locator('#connection-state').filter({ hasText: '尚未连接' }).waitFor();
  assert.equal(await options.locator('#connect-desktop').isDisabled(), true);
  await worker.evaluate(() => {
    globalThis.__nativeFixture = { mode: 'cancel', requests: [], disconnects: 0 };
    chrome.runtime.connectNative = host => {
      const state = globalThis.__nativeFixture; state.host = host;
      let message, disconnected;
      return { onMessage: { addListener: fn => { message = fn; } }, onDisconnect: { addListener: fn => { disconnected = fn; } },
        disconnect() { state.disconnects++; }, postMessage(request) {
          state.requests.push(request);
          queueMicrotask(() => {
            if (state.mode === 'disconnect') return disconnected();
            if (state.mode === 'cancel') return message({ ok: false, error: '已取消连接，未授予浏览器访问权限。' });
            message({ ok: true, protocolVersion: 1, baseUrl: 'http://127.0.0.1:7317', token: state.token });
          });
        } };
    };
  });
  await options.locator('#desktop-consent').check();
  assert.equal(await worker.evaluate(() => globalThis.__nativeFixture.requests.length), 0, 'consent alone cannot start native pairing');
  await options.locator('#connect-desktop').click();
  await options.locator('#desktop-status[data-error=true]').filter({ hasText: '已取消连接' }).waitFor();
  assert.equal(await worker.evaluate(async () => !!(await chrome.storage.local.get('connection')).connection?.token), false);
  await worker.evaluate(() => { globalThis.__nativeFixture.mode = 'disconnect'; });
  await options.locator('#connect-desktop').click();
  await options.locator('#desktop-status[data-error=true]').filter({ hasText: '桌面端未连接' }).waitFor();
  await worker.evaluate(() => { globalThis.__nativeFixture.mode = 'success'; globalThis.__nativeFixture.token = 'malformed'; });
  await options.locator('#connect-desktop').click();
  await options.locator('#desktop-status[data-error=true]').filter({ hasText: '协议或端口不兼容' }).waitFor();
  const instanceId = await worker.evaluate(async () => (await chrome.storage.local.get('desktopInstanceId')).desktopInstanceId);
  const token = pairExtension(id, { instanceId, label: 'Isolated artifact test', directory: config });
  await worker.evaluate(token => { globalThis.__nativeFixture.token = token; }, token);
  await options.locator('#connect-desktop').click();
  await options.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor();
  assert.ok(coreRequests.some(row => row.path === '/health' && row.extension === id && row.instance === instanceId && row.authenticated), 'unchanged ZIP worker must authenticate to the real isolated core');
  const status = await send(options, { type: 'cf-status' });
  assert.equal(status.value.source, 'desktop'); assert.ok(!JSON.stringify(status).includes(token));
  const html = await options.content(); assert.ok(!html.includes(token)); assert.ok(!html.includes(key));
  const fieldValues = await options.evaluate(() => {
    const values = [], inspect = root => { for (const input of root.querySelectorAll('input,textarea')) values.push(input.value);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) inspect(element.shadowRoot); };
    inspect(document); return values;
  });
  assert.ok(fieldValues.every(value => !value.includes(token) && !value.includes(key)), 'credentials must not be filled into visible or hidden form controls');
  assert.equal(await options.locator('#pair-token').inputValue(), '');
  await options.reload(); await options.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor();
  // Real Chromium enforces TRUSTED_CONTEXTS, not merely an emulated JS API.
  const cdp = await context.newCDPSession(article), worlds = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context)); await cdp.send('Runtime.enable');
  const isolated = worlds.find(world => world.name.includes(id) || world.origin.includes(id));
  assert.ok(isolated, 'extension content-script execution context missing');
  const denied = await cdp.send('Runtime.evaluate', { contextId: isolated.id,
    expression: 'chrome.storage.local.get("connection")', awaitPromise: true, returnByValue: true });
  assert.ok(denied.exceptionDetails, 'content script must not read connection credentials');
  const attemptsBefore = await worker.evaluate(() => globalThis.__nativeFixture.requests.length);
  const deniedPairing = await cdp.send('Runtime.evaluate', { contextId: isolated.id,
    expression: 'chrome.runtime.sendMessage({type:"cf-connect-native",consent:true})', awaitPromise: true, returnByValue: true });
  assert.equal(deniedPairing.result.value.ok, false, 'reading content script cannot invoke native pairing');
  assert.equal(await worker.evaluate(() => globalThis.__nativeFixture.requests.length), attemptsBefore);
  await cdp.detach();
  pairExtension(id, { revoke: true, instanceId, directory: config });
  const revoked = await send(options, { type: 'cf-check' }); assert.equal(revoked.value.state, 'unauthorized');
  const meta = await worker.evaluate(() => ({ host: globalThis.__nativeFixture.host, requests: globalThis.__nativeFixture.requests,
    disconnects: globalThis.__nativeFixture.disconnects }));
  assert.equal(meta.host, 'io.github.pengheliu.contextflow');
  assert.ok(meta.requests.every(request => request.consent === true && request.instanceId === instanceId));
  assert.equal(meta.disconnects, meta.requests.length - 1, 'every replied native port closes; disconnect fixture already represents a closed port');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(proxySocketErrors, [], 'unexpected fixture CONNECT socket errors');
  for (const [name, hash] of Object.entries(hashes)) if (name !== 'manifest.json') assert.equal(sha(readFileSync(join(extension, name))), hash, `${name} changed after ZIP extraction`);
  assert.equal(sha(readFileSync(zip)), zipHash, 'release artifact must remain unchanged');
  console.log(`ok Final ZIP ${manifest.version} sha256=${zipHash}: Chromium ${context.browser().version()}; native consent/cancel/disconnect/protocol/success, real HTTP headers, private credential isolation and revocation`);
  console.log('LIMIT: connectNative transport is a narrow worker mock; OS registration/launch/dialog approval and signed installer verification are NOT covered.');
} catch (error) {
  console.error('Artifact acceptance failure:', error.message, '\nDiagnostics:', logs.join('\n').slice(-2500), '\nPage errors:', pageErrors);
  if (article && !article.isClosed()) console.error('Page:', await article.evaluate(() => ({ selection: String(getSelection()), hosts: [...document.querySelectorAll('[data-contextflow]')].map(host => ({ name: host.dataset.contextflow, text: host.shadowRoot?.textContent.slice(-500) })) })));
  throw error;
} finally {
  await context?.close();
  proxy?.closeAllConnections(); if (proxy?.listening) await new Promise(done => proxy.close(done));
  await stop(service);
  rmSync(temporary, { recursive: true, force: true });
}
