import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startDesktopUI } from '../desktop/ui/renderer.js';
import { trayMenuTemplate } from '../desktop/tray-menu.mjs';

const html = readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
const tick = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setTimeout(resolve, 0)); };
const available = () => ({ state: 'available', currentVersion: '1.1.2', latestVersion: '1.2.0', checkedAt: 1793764800000,
  message: '发现适合本机的新版本，可以前往官网下载。', checking: false });
const config = () => ({ translate: { provider: 'openai', model: '', baseUrl: '', apiKeySet: false, target: '简体中文', chunkChars: 5000 },
  explain: { backend: 'llm' }, agent: { id: '', executable: '', profile: 'safe', notesDir: '' }, sync: { backend: 'markdown' },
  markdown: { dir: '/isolated/notes', folder: '/阅读记录' }, obsidian: { vaultPath: '', folder: '/阅读记录' },
  siyuan: { origin: 'http://127.0.0.1:6806', notebookId: '', tokenSet: false }, connectionChecks: {} });

async function fixture(updates = { state: 'idle', currentVersion: '1.1.2', checking: false }) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://desktop-updates.invalid/' });
  const previous = new Map();
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  const calls = [], listeners = new Set(), updateListeners = new Set(), cfg = config(); let statusCalls = 0;
  const state = { version: '1.1.2', platform: 'darwin', architecture: 'arm64', service: { state: 'running' },
    configuration: cfg, pairings: [], preferences: {}, bridgeReady: true, packaged: true,
    updates, recoveryPoints: [], journey: { step: 'tools', dismissed: true }, discovery: {} };
  let check = async () => available();
  const desktop = {
    status: async () => { statusCalls++; return structuredClone(state); }, request: async () => { throw new Error('Unexpected fixture network'); },
    onStatusChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }, onNavigate: () => () => {},
    onUpdatesChange: fn => { updateListeners.add(fn); return () => updateListeners.delete(fn); },
    updates: async action => { calls.push(action); if (action === 'check') return state.updates = await check(); return true; },
    action: async action => { calls.push(`action:${action}`); return true; },
  };
  const serviceAPI = { getConfig: async () => structuredClone(cfg),
    listFolders: async () => ({ folders: [] }), listVaults: async () => ({ vaults: [] }),
    health: async () => ({ serviceVersion: '1.1.2', capabilities: [] }), detectAgents: async () => ({ agents: [] }),
    putConfig: async () => { throw new Error('Update controls must not save a Settings draft'); },
  };
  const ui = startDesktopUI({ root: dom.window.document, desktop, serviceAPI, poll: false });
  await ui.ready; await tick();
  return { state, calls, ui, dom, $: id => dom.window.document.getElementById(id), setCheck: value => { check = value; },
    get statusCalls() { return statusCalls; }, get updateListenerCount() { return updateListeners.size; },
    pushUpdate(updates) { state.updates = updates; for (const fn of updateListeners) fn(updates); },
    async push(updates) { state.updates = updates; for (const fn of listeners) fn(); await tick(); },
    close() { ui.dispose(); dom.window.close(); for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; },
  };
}

test('desktop update icon appears on a published matching version and opens review without starting an install', async () => {
  const f = await fixture();
  try {
    assert.equal(f.$('update-prompt').hidden, true);
    await f.push(available());
    assert.equal(f.$('update-prompt').hidden, false);
    assert.match(f.$('update-prompt').getAttribute('aria-label'), /1\.2\.0/);
    f.$('update-prompt').click(); await tick();
    assert.equal(f.dom.window.document.querySelector('[data-view=support]').hidden, false);
    assert.equal(f.dom.window.document.activeElement.id, 'updates-card');
    assert.match(f.$('update-versions').textContent, /当前 v1\.1\.2.*已发布 v1\.2\.0/);
    assert.equal(f.$('download-update').hidden, false);
    assert.deepEqual(f.calls, [], 'viewing the notice must not open a browser or stop tasks');
    f.$('download-update').click(); await tick();
    assert.deepEqual(f.calls, ['download'], 'only an explicit download action invokes the narrow main-process updater');
    await f.push({ state: 'current', latestVersion: '1.1.2', checkedAt: Date.now(), message: '当前已是最新版本。' });
    assert.equal(f.$('update-prompt').hidden, true);
    assert.equal(f.$('download-update').hidden, true);
    assert.equal(f.$('update-badge').textContent, '已是最新');
  } finally { f.close(); }
});

test('manual check gives immediate progress, merges a result and offers retry for failed or stale checks', async () => {
  const f = await fixture();
  try {
    let finish;
    f.setCheck(() => new Promise(resolve => { finish = resolve; }));
    f.$('check-updates').click();
    assert.equal(f.$('check-updates').disabled, true);
    assert.match(f.$('check-updates').textContent, /正在检查/);
    assert.match(f.$('update-status').textContent, /正在检查/);
    finish(available()); await tick();
    assert.equal(f.$('update-prompt').hidden, false);
    assert.equal(f.$('check-updates').disabled, false);
    assert.equal(f.$('update-check-detail').hidden, false);
    await f.push({ ...available(), stale: true, checkError: '暂时无法检查更新，请稍后重试。' });
    assert.equal(f.$('update-prompt').hidden, false, 'a network failure must not erase a previously discovered release');
    assert.match(f.$('check-updates').textContent, /重新检查/);
    assert.match(f.$('update-check-detail').textContent, /暂时无法检查.*上次成功检查/);
    await f.push({ state: 'current', stale: true, currentVersion: '1.1.2', latestVersion: '1.1.2', checkedAt: Date.now(),
      message: '当前已是最新版本。', checkError: '网络不可用' });
    assert.equal(f.$('update-badge').textContent, '检查未完成');
    assert.doesNotMatch(f.$('update-status').textContent, /已是最新/);
    await f.push({ state: 'error', message: '暂时无法检查更新，请稍后重试。', checking: false });
    assert.equal(f.$('download-update').hidden, true);
    assert.equal(f.$('check-updates').disabled, false);
    assert.match(f.$('update-status').textContent, /暂时无法检查/);
  } finally { f.close(); }
});

test('reviewing and downloading an update preserve the exact focused unsaved AI configuration draft', async () => {
  const f = await fixture();
  try {
    await f.ui.page('ai'); await tick();
    const settings = f.ui.settings, model = settings.$('s-model');
    model.value = 'MY_UNSAVED_MODEL_DRAFT'; model.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    model.focus(); await tick();
    assert.equal(settings.dirty, true);
    await f.push(available());
    f.$('update-prompt').click(); await tick();
    f.$('download-update').click(); await tick();
    await f.ui.page('ai');
    assert.equal(f.ui.settings, settings);
    assert.equal(model.value, 'MY_UNSAVED_MODEL_DRAFT');
    assert.equal(settings.dirty, true);
    assert.deepEqual(f.calls, ['download']);
  } finally { f.close(); }
});

test('native update entry reflects validated versions while exposing no arbitrary feed or service data', () => {
  const calls = [], onUpdates = () => calls.push('updates');
  const rows = updates => trayMenuTemplate({ updates, onUpdates, service: { state: 'running', health: { jobs: { running: 4, queued: 2 } } } });
  let update = rows(available()).find(item => item.id === 'updates');
  assert.equal(update.label, '发现新版本 v1.2.0…'); assert.equal(update.enabled, true); update.click();
  assert.deepEqual(calls, ['updates']);
  update = rows({ state: 'idle', checking: true }).find(item => item.id === 'updates');
  assert.equal(update.label, '正在检查更新…'); assert.equal(update.enabled, false);
  update = rows({ state: 'available', latestVersion: 'https://private.invalid/token=secret' }).find(item => item.id === 'updates');
  assert.equal(update.label, '检查更新…'); assert.doesNotMatch(update.label, /secret/);
});

test('dedicated update push paints the prompt immediately without waiting on service health or refreshing Settings', async () => {
  const f = await fixture();
  try {
    const reads = f.statusCalls;
    f.pushUpdate(available());
    assert.equal(f.$('update-prompt').hidden, false);
    assert.equal(f.$('download-update').hidden, false);
    assert.equal(f.statusCalls, reads, 'public update state must not wait on the service status/config roundtrip');
    // A status frame captured before the public update message cannot regress it.
    f.state.updates = { state: 'idle' }; await f.ui.refresh();
    assert.equal(f.$('update-prompt').hidden, false);
    f.ui.dispose();
    assert.equal(f.updateListenerCount, 0);
  } finally { f.close(); }
});
