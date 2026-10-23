import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { journeyView, updateJourney } from '../desktop/journey.mjs';
import { LocalDiscovery } from '../desktop/discovery.mjs';
import { SyncStatus, destinationKey, destinationIdentity } from '../server/sync-status.mjs';
import { chromeCommand, openReadingInChrome } from '../desktop/browser.mjs';

const cfg = { sync: { backend: 'markdown' }, markdown: { dir: '/private/test-notes', folder: '/阅读记录' } };
test('Suggested default destination is not user confirmation or verified writing', () => {
  assert.deepEqual(journeyView({}, destinationKey(cfg)), {
    step: 'connect', dismissed: false, destination: '', notesConfirmed: false, notesVerified: false, lastSyncAt: null,
  });
  const preferences = updateJourney({ openAtLogin: true }, { step: 'notes', notesConfirmed: true, expectedDestination: destinationIdentity(cfg) }, destinationKey(cfg), destinationIdentity(cfg));
  assert.equal(preferences.openAtLogin, true);
  assert.equal(journeyView(preferences, destinationKey(cfg)).notesConfirmed, true);
  const moved = { ...cfg, markdown: { ...cfg.markdown, dir: '/private/another' } };
  assert.equal(journeyView(preferences, destinationKey(moved)).notesConfirmed, false);
  assert.equal(journeyView(preferences, destinationKey(cfg)).notesVerified, false);
  assert.ok(!JSON.stringify(preferences).includes('/private/'));
});
test('Onboarding can be resumed, deferred and reopened without granting access', () => {
  let preferences = updateJourney({}, { step: 'tools', dismissed: true });
  assert.equal(journeyView(preferences).step, 'tools');
  assert.equal(journeyView(preferences).dismissed, true);
  preferences = updateJourney(preferences, { dismissed: false });
  assert.equal(journeyView(preferences).notesConfirmed, false);
  for (const patch of [null, [], {}, { step: 'unknown' }, { notesConfirmed: 'yes' }, { path: '/etc' }, { dismissed: 1 }]) assert.throws(() => updateJourney({}, patch));
  assert.throws(() => updateJourney({}, { notesConfirmed: true }), /保存笔记/);
});
test('Confirmation rejects a destination changed in another window before the click', () => {
  const changed = { ...cfg, markdown: { ...cfg.markdown, dir: '/new-notes' } };
  assert.throws(() => updateJourney({}, { notesConfirmed: true, expectedDestination: destinationIdentity(cfg) }, destinationKey(changed), destinationIdentity(changed)), /已更改/);
  assert.throws(() => updateJourney({}, { notesConfirmed: true }, destinationKey(cfg), destinationIdentity(cfg)), /已更改/);
  const saved = updateJourney({}, { notesConfirmed: true, expectedDestination: destinationIdentity(changed) }, destinationKey(changed), destinationIdentity(changed));
  assert.equal(journeyView(saved, destinationKey(changed)).notesConfirmed, true);
  assert.ok(!JSON.stringify(saved).includes('/new-notes'), 'public expectation is not persisted as a raw path');
});
test('A real successful sync produces a private destination-bound receipt, not article data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextflow-sync-receipt-'));
  const receipts = new SyncStatus(dir, { now: () => 123456 });
  assert.equal(receipts.record(cfg, { backend: 'markdown', articles: 0 }), false);
  assert.equal(receipts.record(cfg, { backend: 'obsidian', articles: 1 }), false);
  assert.equal(receipts.record(cfg, { backend: 'markdown', articles: 1, inserted: 0, updated: 0, files: [] }), false);
  assert.equal(receipts.view(cfg).verified, false, 'a no-change sync is not first-time write verification');
  assert.equal(receipts.record(cfg, { backend: 'markdown', articles: 2, files: ['/private/article.md'], title: 'SECRET' }), true);
  assert.deepEqual(receipts.view(cfg), { verified: true, lastSyncAt: 123456 });
  assert.deepEqual(new SyncStatus(dir).view(cfg), receipts.view(cfg));
  assert.equal(receipts.record(cfg, { backend: 'markdown', articles: 1, files: [] }), false);
  assert.equal(receipts.view(cfg).verified, true, 'no-change sync preserves an earlier actual write receipt');
  const text = readFileSync(join(dir, 'sync-status.json'), 'utf8');
  assert.ok(!text.includes('/private/') && !text.includes('SECRET'));
  assert.equal(receipts.view({ ...cfg, markdown: { ...cfg.markdown, folder: '/其他' } }).verified, false);
  assert.equal(destinationKey({ sync: { backend: 'siyuan' }, siyuan: { origin: 'http://127.0.0.1:6806' } }), '');
  writeFileSync(join(dir, 'sync-status.json'), '{broken');
  assert.equal(new SyncStatus(dir).view(cfg).verified, false);
});
test('Discovery is parallel, metadata-only, single-flight and cached', async () => {
  const called = [], releases = {};
  let clock = 12345;
  const discovery = new LocalDiscovery({ now: () => clock, request: path => {
    called.push(path); return new Promise(resolve => { releases[path] = resolve; });
  } });
  const pending = discovery.run();
  const second = discovery.run();
  assert.deepEqual(called, ['/agents/detect', '/obsidian/vaults']);
  assert.equal(discovery.snapshot().agents.state, 'running');
  releases['/obsidian/vaults']({ status: 200, body: { vaults: [{ name: '笔记', path: '/vault', exists: true }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(discovery.snapshot().notes.state, 'done');
  assert.equal(discovery.snapshot().agents.state, 'running');
  releases['/agents/detect']({ status: 200, body: { agents: [{ id: 'codex', available: true }] } });
  await Promise.all([pending, second]);
  assert.equal(discovery.snapshot().notes.items[0].backend, 'obsidian');
  await discovery.run(); assert.equal(called.length, 2);
  const snapshot = discovery.snapshot(); snapshot.agents.items.length = 0;
  assert.equal(discovery.snapshot().agents.items.length, 1);
  clock += 600001;
  const fresh = discovery.run({ fresh: true });
  releases['/agents/detect?fresh=1']({ status: 200, body: { agents: [] } });
  releases['/obsidian/vaults']({ status: 200, body: { vaults: [] } });
  await fresh; assert.equal(discovery.snapshot().agents.state, 'done');
});
test('Discovery timeouts and malformed results stay independent and offer manual recovery', async () => {
  const discovery = new LocalDiscovery({ timeoutMs: 15, request: path => path.includes('agents')
    ? new Promise(() => {}) : Promise.resolve({ status: 200, body: { vaults: [] } }) });
  await discovery.run();
  assert.equal(discovery.snapshot().agents.state, 'error');
  assert.equal(discovery.snapshot().notes.state, 'done');
  assert.match(discovery.snapshot().agents.error, /手动选择/);
});
test('Packaged first-run UI is shown before waiting for service startup', () => {
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const paint = main.indexOf("service.update('starting', '正在为阅读准备本地连接…')");
  const start = main.indexOf('await service.start();', paint);
  assert.ok(paint > 0 && main.indexOf('show();', paint) < start);
  assert.match(main, /if \(!smoke\) discovery.run\(\)/);
  assert.match(main, /service.request\('\/desktop\/state', \{\}, \{ timeoutMs: 8000 \}\)/, 'readiness uses one bounded config/health frame, not a 120-second task request');
});
test('Continue reading targets Chrome explicitly without guessing a profile or executing a shell', async () => {
  const url = 'https://pengheliu.github.io/ContextFlow/demo.html';
  assert.deepEqual(chromeCommand(url, { platform: 'darwin' }), { file: '/usr/bin/open', args: ['-b', 'com.google.Chrome', url] });
  const env = { LOCALAPPDATA: 'C:\\Users\\中文\\AppData\\Local' };
  const command = chromeCommand(url, { platform: 'win32', env, exists: file => file.endsWith('chrome.exe') });
  assert.match(command.file, /中文.*chrome\.exe$/); assert.deepEqual(command.args, [url]);
  assert.throws(() => chromeCommand('file:///private/data', { platform: 'darwin' }));
  assert.equal(chromeCommand(url, { platform: 'win32', env: {}, exists: () => false }), null);
  let opened;
  await openReadingInChrome(url, { platform: 'darwin', execute: async (file, args) => { opened = { file, args }; } });
  assert.deepEqual(opened.args, ['-b', 'com.google.Chrome', url]);
  await assert.rejects(() => openReadingInChrome(url, { platform: 'win32', env: {}, exists: () => false }), /未找到 Chrome/);
});
