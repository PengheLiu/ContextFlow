// A real unpacked extension is reloaded while an article keeps its old content
// script. Only this run's browser profile, fixture page and extension DB exist.
// No installed companion, personal profile, model or notebook is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to the existing runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-extension-reload-'));
const config = join(temporary, 'empty-config'), extension = join(temporary, 'extension');
const evidence = join(root, 'release/product-evidence/extension-reload');
mkdirSync(config); mkdirSync(evidence, { recursive: true });
const serviceRequests = [], pageErrors = [], navigation = [];
const saved = 'SAVED_BEFORE_EXTENSION_RELOAD';
const draft = 'UNSAVED_AFTER_EXTENSION_RELOAD\n多人协作时，super-agent 是团队共享一个，还是每个人一个？';
const fixture = createServer((request, response) => {
  if (request.url.startsWith('/isolated-service')) {
    serviceRequests.push(request.url);
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Isolated companion is intentionally unavailable' }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Extension reload fixture</title>
    <style>html{background:white;color:#222}body{font:18px/1.8 system-ui;margin:48px;max-width:850px}p{margin:24px 0}</style>
    <h1>Keep an annotation through an extension update</h1>
    <p id="selection">A super-agent should keep its user in control of collaborative work.</p>
    <textarea id="host-draft">HOST_OWNED_UNSAVED_FORM</textarea>
    <script>window.fixtureDocumentIdentity=Math.random();localStorage.setItem('host-owned','preserve-host-storage');</script>`);
});
let context, page, worker;
const waitFor = async (read, predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 40));
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
};
const events = () => worker.evaluate(() => new Promise((resolveRows, reject) => {
  const request = indexedDB.open('contextflow-offline');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result, read = db.transaction('events').objectStore('events').getAll();
    read.onsuccess = () => { db.close(); resolveRows(read.result.filter(event => !event.deletedAt)); };
    read.onerror = () => { db.close(); reject(read.error); };
  };
}));
const hostState = () => page.evaluate(async () => ({
  identity: window.fixtureDocumentIdentity,
  url: location.href,
  hostDraft: document.querySelector('#host-draft').value,
  localStorage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
  databases: (await indexedDB.databases()).map(database => database.name).sort(),
}));

try {
  await new Promise(ready => fixture.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    cwd: root, env: { ...process.env, CONTEXTFLOW_DIR: config, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe',
  });
  // Even a mistakenly paired service request can only reach our own mock.
  const workerFile = join(extension, 'sw.js');
  writeFileSync(workerFile, readFileSync(workerFile, 'utf8').replaceAll('http://127.0.0.1:7317', `${base}/isolated-service`));
  const launch = () => chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
    headless: true, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context = await launch();
  context.setDefaultTimeout(10000);
  worker = context.serviceWorkers().find(candidate => candidate.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { predicate: candidate => candidate.url().startsWith('chrome-extension://') });
  const extensionId = new URL(worker.url()).hostname;
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigation.push(frame.url()); });
  await page.goto(`${base}/article`);
  await page.locator('[data-contextflow="panel"]').waitFor({ state: 'attached' });
  await page.locator('#selection').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '批注', exact: true }).click();
  const editor = page.locator('[data-contextflow="tip-comment"]');
  const input = editor.locator('textarea');
  await input.fill(saved);
  const rows = await waitFor(events, values => values.some(value => value.action === 'comment' && value.value === saved), 'initial annotation must be durable');
  const commentId = rows.find(value => value.action === 'comment' && value.value === saved).id;
  const before = await hostState(), beforeNavigation = navigation.length;
  await worker.evaluate(() => chrome.runtime.reload()).catch(error => {
    assert.match(error.message, /closed|destroyed|terminated|Execution context/i, 'only the expected reload detachment is tolerated');
  });
  await input.fill(draft);
  await editor.getByRole('button', { name: '完成', exact: true }).click();
  const state = editor.locator('#state');
  await waitFor(() => state.textContent(), value => /保存通道已断开|扩展已更新|保存失败/.test(value), 'old context should report a handled save failure');
  const failure = await state.textContent();
  assert.match(failure, /扩展已更新或重载|保存通道已断开/, 'an orphaned content script must give recovery guidance instead of raw JS: ' + failure);
  assert.doesNotMatch(failure, /Cannot read properties|sendMessage|TypeError/);
  assert.equal(await input.inputValue(), draft);
  assert.equal(await editor.locator('#c').isVisible(), true);
  await editor.getByRole('button', { name: '复制批注', exact: true }).waitFor({ state: 'visible' });
  const downloadButton = editor.getByRole('button', { name: '下载草稿', exact: true });
  await downloadButton.waitFor({ state: 'visible' });
  assert.deepEqual(await hostState(), before, 'no auto refresh, navigation, host draft edits or page-origin storage fallback');
  assert.equal(navigation.length, beforeNavigation);

  // Native blob downloads still work after extension APIs are invalidated.
  // Clipboard is left untouched; this test only checks that explicit copy is offered.
  const downloaded = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloaded;
  const backup = await download.path();
  assert.ok(backup, 'a downloadable draft must be generated without background messaging');
  const markdown = readFileSync(backup, 'utf8');
  assert.ok(markdown.includes(draft));
  assert.match(markdown, /草稿|未保存|未确认/);
  assert.equal(await input.inputValue(), draft);
  assert.equal(await editor.locator('#c').isVisible(), true);
  await input.press('Escape');
  assert.equal(await editor.locator('#c').isVisible(), true, 'Escape must not conceal the unsaved orphaned editor');
  assert.deepEqual(await hostState(), before);
  await page.screenshot({ path: join(evidence, 'orphaned-editor-draft-recovery.png'), fullPage: true });

  // The native unload confirmation protects both the annotation and any host
  // form draft. Exporting a copy is not an acknowledgement of durable saving.
  const interrupted = page.waitForEvent('dialog');
  const dismissedReload = page.reload({ waitUntil: 'domcontentloaded', timeout: 2000 }).then(() => ({ reloaded: true }), error => ({ error: error.message }));
  const warning = await interrupted;
  assert.equal(warning.type(), 'beforeunload');
  await warning.dismiss();
  const canceledNavigation = await dismissedReload;
  assert.equal(canceledNavigation.reloaded, undefined, 'dismissed unload must not refresh the document');
  // Chromium may leave Playwright's navigation waiter pending after a native
  // dismissal instead of returning ERR_ABORTED. The document readback below
  // proves that no reload occurred in either case.
  assert.match(canceledNavigation.error, /ERR_ABORTED|canceled|cancelled|Timeout/i);
  assert.equal(await input.inputValue(), draft);
  assert.deepEqual(await hostState(), before);

  // Only the explicit reload after the backup may accept the native warning.
  const explicitReload = page.waitForEvent('dialog').then(async dialog => {
    assert.equal(dialog.type(), 'beforeunload');
    await dialog.accept();
  });
  await page.reload(); await explicitReload;

  // Chromium disables command-line-loaded unpacked packages after self-reload
  // in this harness. Reopen the SAME disposable profile/path to reactivate it;
  // no uninstall, storage editing or user browser is involved. The first phase
  // above exercises the actual orphaned script, not a mocked runtime error.
  await context.close(); context = null;
  context = await launch(); context.setDefaultTimeout(10000);
  worker = context.serviceWorkers().find(candidate => candidate.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { predicate: candidate => candidate.url().startsWith('chrome-extension://') });
  assert.equal(new URL(worker.url()).hostname, extensionId);
  assert.equal((await events()).find(value => value.id === commentId).value, saved, 'failed save and draft export never overwrite the prior durable record');
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${base}/article`);
  await page.locator('[data-contextflow="panel"]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  const panel = page.locator('[data-contextflow="panel"]');
  await panel.locator('#wrap').waitFor({ state: 'visible' });
  // Sidebar textareas carry their content in value rather than text nodes.
  const index = await panel.locator('textarea').evaluateAll((fields, value) => fields.findIndex(field => field.value === value), saved);
  assert.ok(index >= 0, 'fresh content script restores the previously durable annotation');
  await panel.locator('textarea').nth(index).fill(draft);
  await waitFor(events, values => values.some(value => value.id === commentId && value.value === draft), 'fresh context can explicitly save the backed-up draft');
  assert.deepEqual(serviceRequests, [], 'reload recovery cannot contact a real or mocked companion');
  assert.deepEqual(pageErrors, [], 'runtime invalidation must not escape as an uncaught page error');
  const report = { format: 'ContextFlowExtensionReload', extensionId, orphanedDraftRetained: true,
    draftDownloadVerified: true, priorDurableRecordRetained: true, freshContextSavePassed: true,
    pageOriginStorageUnchanged: true, automaticPageReloads: 0,
    harnessReactivation: 'same-isolated-profile-restart', realServiceRequests: 0, realModelCalls: 0 };
  writeFileSync(join(evidence, 'reload-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await context?.close();
  await new Promise(done => fixture.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
