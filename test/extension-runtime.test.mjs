import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { encodeMessage, decodeMessage } from '../src/ext/rpc.js';
import { browserStorage, setBrowserStorage } from '../src/core/browser-storage.js';
import { setOfflineTransport, saveOfflineEvents, available, openOfflineStore } from '../src/core/offline-store.js';

const id = 'a'.repeat(32);
const settingsSender = { id, url: `chrome-extension://${id}/options.html` };
const pageSender = { id, url: 'https://example.org/article', tab: { id: 1 }, frameId: 0 };
const stored = {};
const listeners = {};
let accessLevel;
let lastFetch;
globalThis.chrome = {
  runtime: { id, getURL: (path) => `chrome-extension://${id}/${path}`,
    onMessage: { addListener: (listener) => { listeners.message = listener; } },
    onInstalled: { addListener: (listener) => { listeners.installed = listener; } },
    openOptionsPage: async () => {},
  },
  action: { onClicked: { addListener: (listener) => { listeners.action = listener; } } },
  tabs: { sendMessage: async () => {} },
  storage: { local: {
    setAccessLevel: async (options) => { accessLevel = options.accessLevel; },
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])),
    set: async (values) => { Object.assign(stored, structuredClone(values)); },
    remove: async (key) => { delete stored[key]; },
  } },
};
globalThis.fetch = async (url, init) => {
  lastFetch = { url, init };
  return { status: 200, json: async () => ({ ok: true, extensionPaired: true }) };
};
await import('../extension/sw.js');

const send = async (message, sender = pageSender) => {
  const encoded = await encodeMessage(message);
  return new Promise((resolve) => listeners.message(encoded, sender, resolve));
};
assert.equal(accessLevel, 'TRUSTED_CONTEXTS');
assert.equal((await send({ type: 'cf-fetch', path: '/health' })).status, 428);
assert.equal(lastFetch, undefined);
assert.equal((await send({ type: 'cf-status' }, { ...settingsSender, id: 'b'.repeat(32) })).ok, false);
assert.equal((await send({ type: 'cf-status' })).ok, false);
const token = 'a'.repeat(43);
assert.equal((await send({ type: 'cf-connect', token, consent: true })).ok, false);
assert.equal((await send({ type: 'cf-connect', token, consent: false }, settingsSender)).ok, false);
assert.equal((await send({ type: 'cf-connect', token, consent: true }, settingsSender)).ok, true);
assert.equal(stored.connection.token, token);
assert.equal(JSON.stringify(await send({ type: 'cf-status' }, settingsSender)).includes(token), false);
await send({ type: 'cf-fetch', path: '/health', init: { headers: { Authorization: 'evil' } } });
assert.equal(lastFetch.init.headers.Authorization, `Bearer ${token}`);
assert.equal(lastFetch.init.headers['X-ContextFlow-Extension'], id);
assert.equal(lastFetch.init.redirect, 'error');
assert.equal((await send({ type: 'cf-fetch', path: '//evil.example/health' })).status, 400);
assert.equal((await send({ type: 'cf-fetch', path: '/health/../config' })).status, 400);
assert.equal((await send({ type: 'cf-ui-write', key: 'connection', value: '{}' })).ok, false);
await send({ type: 'cf-ui-write', key: 'contextflow:ui', value: '{"open":true}' });
assert.equal((await send({ type: 'cf-ui-snapshot' })).value['contextflow:ui'], '{"open":true}');
assert.equal((await send({ type: 'cf-ui-snapshot' }, { ...pageSender, url: 'https://other.example/article' })).value['contextflow:ui'], null);
assert.equal((await send({ type: 'cf-offline', method: 'openOfflineStore', args: [] })).ok, false);
const event = { id: 'event-1', urlKey: 'article-1', action: 'highlight', value: 'private-note' };
assert.equal((await send({ type: 'cf-offline', method: 'saveOfflineEvents', args: [[event]] })).ok, true);
const events = await send({ type: 'cf-offline', method: 'listOfflineEvents', args: ['article-1'] });
assert.equal(events.value[0].value, 'private-note');
const asset = await send({ type: 'cf-offline', method: 'saveOfflineAsset', args: [new Blob(['image-bytes'], { type: 'image/png' })] });
assert.equal(asset.ok, true);
assert.equal(await decodeMessage(asset.value).blob.text(), 'image-bytes');
const storedAsset = await send({ type: 'cf-offline', method: 'getOfflineAsset', args: [asset.value.id] });
assert.equal(await decodeMessage(storedAsset.value).blob.text(), 'image-bytes');
await send({ type: 'cf-disconnect' }, settingsSender);
assert.equal((await send({ type: 'cf-fetch', path: '/health' })).status, 428);

setOfflineTransport(async (method, args) => ({ method, args }));
assert.equal(available(), true);
assert.throws(() => openOfflineStore(), /私有存储/);
assert.equal((await saveOfflineEvents([event])).method, 'saveOfflineEvents');
setOfflineTransport(null);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('宿主存储不可访问'); } });
setBrowserStorage({ getItem: () => 'private' });
assert.equal(browserStorage().getItem('key'), 'private');
console.log('扩展运行时：来源校验、配对、凭证不回显、站点偏好隔离、离线记录与图片 RPC 通过');
