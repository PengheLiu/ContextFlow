import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createExtensionUpdates, setupUpdatePage, UPDATE_ALARM } from '../src/ext/updates.js';
import { UPDATE_FEED_URL, UPDATE_STORE_URL, UPDATE_DOWNLOAD_URL } from '../src/core/updates.js';

const published = (extension = '1.2.0') => ({ schemaVersion: 1,
  extension: { version: extension, url: UPDATE_STORE_URL, releaseNotesUrl: `https://github.com/PengheLiu/ContextFlow/releases/tag/v${extension}` },
  desktop: { 'darwin-arm64': { version: '1.1.2', url: UPDATE_DOWNLOAD_URL, releaseNotesUrl: 'https://github.com/PengheLiu/ContextFlow/releases/tag/v1.1.2' } },
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture({ development = false, currentVersion = '1.1.1', stored = {} } = {}) {
  const listeners = {}, requests = [], badges = [], notices = [], created = [], records = structuredClone(stored);
  let model = published(), storeCalls = 0, storeStatus = 'no_update', storeDetails, reloads = 0, fail = false;
  const event = name => ({ addListener: fn => { listeners[name] = fn; }, removeListener: () => { delete listeners[name]; } });
  const chrome = {
    runtime: { id: 'a'.repeat(32), getManifest: () => ({ version: currentVersion, ...(development ? {} : { update_url: 'https://clients2.google.com/service/update2/crx' }) }),
      getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}`, onStartup: event('startup'), onUpdateAvailable: event('staged'),
      sendMessage: async message => { notices.push(message); }, reload: () => { reloads++; },
      requestUpdateCheck: callback => { storeCalls++; callback(storeStatus, storeDetails); } },
    storage: { local: { get: async key => ({ [key]: records[key] }), set: async value => { Object.assign(records, value); }, remove: async key => { delete records[key]; } } },
    alarms: { get: async () => null, create: async (...args) => { created.push(args); }, onAlarm: event('alarm') },
    action: { setBadgeText: async value => { badges.push(value.text); }, setBadgeBackgroundColor: async () => {} },
    tabs: { query: async () => [{ id: 1 }, { id: 2 }], sendMessage: async (id, message) => { notices.push({ id, ...message }); }, create: async value => { created.push(value); } },
  };
  const manager = createExtensionUpdates({ chrome, now: () => 1793760000000,
    fetch: async (...args) => { requests.push(args); if (fail) throw new Error('private proxy failure'); return new Response(JSON.stringify(model)); } });
  return { manager, chrome, listeners, requests, badges, notices, created, records,
    setFeed: value => { model = value; }, setFail: value => { fail = value; },
    setStore: (status, details) => { storeStatus = status; storeDetails = details; },
    get storeCalls() { return storeCalls; }, get reloads() { return reloads; } };
}

test('periodic public checks are cached, use no credentials, and never poll Chrome store or reload pages', async () => {
  const f = fixture();
  try {
    const state = await f.manager.check();
    assert.equal(state.available, true); assert.equal(state.latestVersion, '1.2.0');
    assert.equal(f.storeCalls, 0); assert.equal(f.reloads, 0);
    assert.deepEqual(f.created[0], [UPDATE_ALARM, { periodInMinutes: 360 }]);
    assert.equal(f.requests[0][0], UPDATE_FEED_URL);
    assert.equal(f.requests[0][1].credentials, 'omit');
    assert.equal(f.badges.at(-1), '↑');
    assert.ok(f.notices.some(value => value.type === 'cf-update-state' && value.updates.available));
    f.listeners.alarm({ name: UPDATE_ALARM }); await tick();
    assert.equal(f.requests.length, 1); assert.equal(f.storeCalls, 0);
    await f.manager.check({ force: true });
    assert.equal(f.requests.length, 2); assert.equal(f.storeCalls, 1);
  } finally { f.manager.dispose(); }
});

test('a real staged Chrome update survives worker restart and is cleared by a newer installed version', async () => {
  const f = fixture();
  try {
    f.setFeed(published('1.1.1')); f.setStore('update_available', { version: '1.3.0' });
    const state = await f.manager.check({ force: true });
    assert.equal(state.state, 'available'); assert.equal(state.stagedVersion, '1.3.0');
    assert.match(state.message, /Chrome 已下载/);
    assert.equal(f.records.stagedExtensionUpdate, '1.3.0'); assert.equal(f.reloads, 0);
    f.listeners.staged({ version: 'https://untrusted.test/' }); await tick();
    assert.equal(f.manager.snapshot().stagedVersion, '1.3.0');
    const resumed = fixture({ currentVersion: '1.2.0', stored: f.records });
    const upgraded = fixture({ currentVersion: '1.3.0', stored: f.records });
    try {
      await resumed.manager.ready; assert.equal(resumed.manager.snapshot().stagedVersion, '1.3.0');
      await upgraded.manager.ready; assert.equal(upgraded.manager.snapshot().stagedVersion, undefined);
      assert.equal(upgraded.records.stagedExtensionUpdate, undefined);
    } finally { resumed.manager.dispose(); upgraded.manager.dispose(); }
    f.setStore('no_update'); const rechecked = await f.manager.check({ force: true });
    assert.equal(rechecked.stagedVersion, '1.3.0', 'a no_update response does not revoke an already downloaded, verified staged update');
    assert.equal(rechecked.available, true);
    assert.equal(f.records.stagedExtensionUpdate, '1.3.0');
  } finally { f.manager.dispose(); }
});

test('development installs never request a store update; offline and throttled results remain truthful', async () => {
  const f = fixture({ development: true }), store = fixture();
  try {
    const state = await f.manager.check({ force: true });
    assert.equal(state.development, true); assert.equal(f.storeCalls, 0);
    assert.match(state.message, /开发版/);
    f.setFail(true); const failed = await f.manager.check({ force: true });
    assert.equal(failed.available, true); assert.equal(failed.stale, true);
    assert.ok(failed.checkError); assert.doesNotMatch(failed.message, /已安装|已更新成功/);
    store.setStore('throttled'); const throttled = await store.manager.check({ force: true });
    assert.equal(throttled.browserStatus, 'throttled'); assert.match(throttled.message, /限制/);
  } finally { f.manager.dispose(); store.manager.dispose(); }
});

test('update navigation uses only fixed destinations and cannot execute a supplied URL', async () => {
  const f = fixture();
  try {
    await f.manager.ready;
    await f.manager.open(); await f.manager.open('manage'); await f.manager.open('store');
    const urls = f.created.filter(value => value.url).map(value => value.url);
    assert.deepEqual(urls, [`chrome-extension://${'a'.repeat(32)}/options.html#updates`, `chrome://extensions/?id=${'a'.repeat(32)}`, UPDATE_STORE_URL]);
    await assert.rejects(f.manager.open('https://untrusted.test'), /无效/);
    assert.equal(f.reloads, 0);
  } finally { f.manager.dispose(); }
});

test('settings show availability and retry feedback without claiming an update was installed', async () => {
  const dom = new JSDOM(readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8'));
  const document = dom.window.document, sent = []; let listener, release;
  const api = setupUpdatePage({ root: document, version: '1.1.1', runtime: { onMessage: { addListener: fn => { listener = fn; }, removeListener() {} } },
    request: async message => { sent.push(message); if (message.type === 'cf-check-updates') return new Promise(resolve => { release = resolve; }); return { state: 'current', available: false, latestVersion: '1.1.1', message: '当前已是最新公开版本。' }; } });
  try {
    await tick(); assert.equal(document.getElementById('update-indicator').hidden, true);
    listener({ type: 'cf-update-state', updates: { state: 'available', available: true, latestVersion: '1.2.0', message: '发现新版本。', checkedAt: 1793760000000 } });
    assert.equal(document.getElementById('update-indicator').hidden, false);
    assert.equal(document.getElementById('update-latest').textContent, 'v1.2.0');
    document.getElementById('check-updates').click();
    assert.equal(document.getElementById('check-updates').disabled, true);
    release({ state: 'available', available: true, latestVersion: '1.2.0', message: '发现新版本。', checkError: '稍后重试', stale: true });
    await tick(); assert.equal(document.getElementById('check-updates').disabled, false);
    assert.match(document.getElementById('update-message').textContent, /稍后重试/);
    document.getElementById('update-manage').click(); await tick();
    assert.deepEqual(sent.at(-1), { type: 'cf-open-update', operation: 'manage' });
    assert.doesNotMatch(document.getElementById('update-message').textContent, /更新成功|安装成功/);
  } finally { api.dispose(); dom.window.close(); }
});

test('worker update RPC rejects forged origins and keeps management destinations fixed', async () => {
  const f = fixture(), previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  let receive;
  f.manager.dispose();
  f.chrome.runtime.onMessage = { addListener: fn => { receive = fn; } };
  f.chrome.runtime.onInstalled = { addListener() {} };
  f.chrome.runtime.openOptionsPage = async () => {};
  f.chrome.action.onClicked = { addListener() {} };
  f.chrome.storage.local.setAccessLevel = async () => {};
  globalThis.chrome = f.chrome;
  globalThis.fetch = async () => new Response(JSON.stringify(published()));
  try {
    await import(`../extension/sw.js?updates-rpc=${Date.now()}`);
    const page = { id: f.chrome.runtime.id, url: 'https://example.org/article', tab: { id: 20 }, frameId: 0 };
    const send = (message, sender = page) => new Promise(resolve => receive(message, sender, resolve));
    const denied = await send({ type: 'cf-check-updates' }, { ...page, id: 'b'.repeat(32) });
    assert.equal(denied.ok, false);
    assert.equal((await send({ type: 'cf-update-status' }, { ...page, frameId: 1 })).ok, false);
    const checked = await send({ type: 'cf-check-updates' });
    assert.equal(checked.ok, true); assert.equal(checked.value.available, true);
    assert.equal((await send({ type: 'cf-open-update', operation: 'https://untrusted.test' })).ok, false);
    await send({ type: 'cf-open-update', url: 'https://untrusted.test' });
    assert.equal(f.created.at(-1).url, `chrome-extension://${f.chrome.runtime.id}/options.html#updates`);
    assert.equal(f.reloads, 0);
  } finally { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; }
});
