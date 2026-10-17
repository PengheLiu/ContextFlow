import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('请用 CONTEXTFLOW_PLAYWRIGHT_DIR 指定安装了 playwright 的测试运行目录');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-browser-test-'));
const config = join(temporary, 'config');
const extension = join(temporary, 'extension');
const screenshots = join(root, 'release', 'store-assets');
mkdirSync(config);
mkdirSync(screenshots, { recursive: true });
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const environment = { ...process.env, CONTEXTFLOW_DIR: config, ANTHROPIC_API_KEY: '', HOME: temporary };
writeFileSync(join(config, 'config.json'), JSON.stringify({ port, requireToken: true, token: 'browser-test-only', allowedOrigins: [] }));
let service;
let context;
let fixture;
let article;
const logs = [];

try {
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    cwd: root, env: { ...environment, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe',
  });
  const workerFile = join(extension, 'sw.js');
  writeFileSync(workerFile, readFileSync(workerFile, 'utf8').replaceAll('http://127.0.0.1:7317', base));
  const manifestFile = join(extension, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.host_permissions = [`${base}/*`];
  if (process.env.CONTEXTFLOW_STORE_PUBLIC_KEY_FILE) {
    manifest.key = readFileSync(resolve(process.env.CONTEXTFLOW_STORE_PUBLIC_KEY_FILE), 'utf8').trim();
  }
  writeFileSync(manifestFile, JSON.stringify(manifest));
  service = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium',
    executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH,
    headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(8000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  if (process.env.CONTEXTFLOW_EXPECTED_EXTENSION_ID) {
    assert.equal(extensionId, process.env.CONTEXTFLOW_EXPECTED_EXTENSION_ID);
    console.log(`ok 商店扩展 ID：${extensionId}`);
  }
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const pairingOutput = execFileSync(process.execPath, ['tools/pair-extension.mjs', extensionId], { cwd: root, env: environment, encoding: 'utf8' });
  const token = pairingOutput.split('\n').find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
  await options.locator('#pair-token').fill(token);
  await options.locator('#consent').check();
  await options.getByRole('button', { name: '验证并连接' }).click();
  await options.locator('#status').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(await options.locator('#pair-token').inputValue(), '');
  console.log('ok 浏览器实际请求完成独立配对');

  fixture = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(readFileSync(join(root, 'store/demo.html')));
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  article = await context.newPage();
  article.on('console', (message) => { if (['error', 'warning'].includes(message.type())) logs.push(message.text()); });
  article.on('pageerror', (error) => logs.push(`PAGE_ERROR: ${error.message}`));
  const pageReady = article.waitForEvent('console', { predicate: (message) => message.text().includes('[ContextFlow] 就绪') });
  await article.goto(`http://127.0.0.1:${fixture.address().port}/reading`);
  await article.getByRole('button', { name: '展开 ContextFlow', exact: true }).waitFor();
  await pageReady;
  console.log('ok content script 私有存储初始化并显示入口');
  await article.locator('#selection').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.getByRole('button', { name: 'yellow 高亮', exact: true }).click();
  await article.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await article.waitForFunction(() => document.querySelector('[data-contextflow="panel"]')?.shadowRoot?.textContent.includes('阅读的价值'));
  const pageStorage = await article.evaluate(async () => ({ keys: Object.keys(localStorage), databases: (await indexedDB.databases()).map((database) => database.name) }));
  assert.deepEqual(pageStorage, { keys: [], databases: [] });
  await article.screenshot({ path: join(screenshots, 'reading-1280x800.png') });
  const promotional = await context.newPage();
  await promotional.setViewportSize({ width: 440, height: 280 });
  await promotional.setContent(`<style>body{margin:0}</style>${readFileSync(join(root, 'store/promo.svg'), 'utf8')}`);
  await promotional.screenshot({ path: join(screenshots, 'promo-440x280.png') });
  await promotional.close();
  console.log('ok 高亮保存，网页 localStorage / IndexedDB 均没有批注数据');
  await article.reload();
  await article.waitForFunction(() => document.querySelector('[data-contextflow="panel"]')?.shadowRoot?.textContent.includes('阅读的价值'));
  console.log('ok 刷新后从扩展私有存储恢复');
  const devtools = await context.newCDPSession(article);
  const worlds = [];
  devtools.on('Runtime.executionContextCreated', ({ context: executionContext }) => worlds.push(executionContext));
  await devtools.send('Runtime.enable');
  const isolated = worlds.find((world) => world.name.includes(extensionId) || world.origin.includes(extensionId));
  assert.ok(isolated, '未找到扩展 content script 隔离上下文');
  const result = await devtools.send('Runtime.evaluate', { contextId: isolated.id,
    expression: 'chrome.storage.local.get("connection")', awaitPromise: true, returnByValue: true });
  assert.ok(result.exceptionDetails, 'content script 不应读取配对凭证');
  await devtools.detach();
  console.log('ok 浏览器拒绝 content script 直接读取配对凭证');
  execFileSync(process.execPath, ['tools/pair-extension.mjs', '--revoke', extensionId], { cwd: root, env: environment, stdio: 'pipe' });
  await options.locator('#pair-token').fill(token);
  await options.getByRole('button', { name: '验证并连接' }).click();
  await options.locator('#status[data-error="true"]').waitFor();
  assert.match(await options.locator('#status').textContent(), /撤销|无效/);
  console.log('ok 撤销后旧配对码无法再次连接');
  service.kill();
  await once(service, 'exit');
  const secondQuote = await article.locator('article p').nth(1).textContent();
  await article.locator('article p').nth(1).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.getByRole('button', { name: 'yellow 高亮', exact: true }).click();
  await article.waitForFunction((quote) => document.querySelector('[data-contextflow="panel"]')?.shadowRoot?.textContent.includes(quote), secondQuote.slice(0, 12));
  const offlineReady = article.waitForEvent('console', { predicate: (message) => message.text().includes('[ContextFlow] 就绪') });
  await article.reload();
  await offlineReady;
  await article.waitForFunction((quote) => document.querySelector('[data-contextflow="panel"]')?.shadowRoot?.textContent.includes(quote), secondQuote.slice(0, 12));
  const downloadPromise = article.waitForEvent('download');
  await article.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const download = await downloadPromise;
  const markdown = readFileSync(await download.path(), 'utf8');
  assert.ok(markdown.includes(secondQuote.trim()));
  assert.ok(markdown.includes('阅读的价值'));
  console.log('ok 服务停止时仍可新增高亮、刷新恢复并导出 Markdown');
  rmSync(join(screenshots, 'test-failure.png'), { force: true });
  console.log(`浏览器端到端验证通过：${context.browser().version()}`);
} catch (error) {
  console.error(logs.join('\n'));
  if (article) {
    console.error(await article.evaluate(() => ({ loaded: document.documentElement.dataset.contextflowLoaded,
      hosts: [...document.querySelectorAll('[data-contextflow]')].map((element) => element.getAttribute('data-contextflow')) })));
    await article.screenshot({ path: join(screenshots, 'test-failure.png') });
  }
  throw error;
} finally {
  if (context) await context.close();
  if (fixture) await new Promise((resolve) => fixture.close(resolve));
  if (service && service.exitCode === null) { service.kill(); await once(service, 'exit'); }
  rmSync(temporary, { recursive: true, force: true });
}
