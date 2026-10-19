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
let optionsOpened = 0;
let toggledTab;
let settingsTab;
globalThis.chrome = {
  runtime: { id, getURL: (path) => `chrome-extension://${id}/${path}`,
    onMessage: { addListener: (listener) => { listeners.message = listener; } },
    onInstalled: { addListener: (listener) => { listeners.installed = listener; } },
    openOptionsPage: async () => { optionsOpened++; },
  },
  action: { onClicked: { addListener: (listener) => { listeners.action = listener; } } },
  tabs: { sendMessage: async (tab) => { toggledTab = tab; }, create: async (options) => { settingsTab = options; } },
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
assert.equal((await send({ type: 'cf-check' }, settingsSender)).value.state, 'unpaired');
assert.equal(lastFetch, undefined, '未配对时检查状态不应请求服务');
await listeners.action({ id: 42 });
assert.equal(toggledTab, 42, '未配对也应打开文章侧栏');
assert.equal(optionsOpened, 0, '不能强制新用户先配对');
assert.equal((await send({ type: 'cf-open-settings' })).ok, true);
assert.equal(settingsTab.url, `chrome-extension://${id}/options.html#connect`);
assert.equal((await send({ type: 'cf-status' }, { ...settingsSender, url: settingsSender.url + '#connect' })).ok, true);
assert.equal((await send({ type: 'cf-status' }, { ...settingsSender, id: 'b'.repeat(32) })).ok, false);
assert.equal((await send({ type: 'cf-status' })).ok, false);
assert.equal((await send({ type: 'cf-configuration-changed' })).ok, false, '网页不能广播配置更改');
assert.equal((await send({ type: 'cf-configuration-changed' }, settingsSender)).ok, true);
const token = 'a'.repeat(43);
assert.equal((await send({ type: 'cf-connect', token, consent: true })).ok, false);
assert.equal((await send({ type: 'cf-connect', token, consent: false }, settingsSender)).ok, false);
assert.equal((await send({ type: 'cf-connect', token, consent: true }, settingsSender)).ok, true);
assert.equal(stored.connection.token, token);
assert.equal((await send({ type: 'cf-check' }, settingsSender)).value.state, 'connected');
assert.equal((await send({ type: 'cf-check' })).ok, false, '网页侧不得读取连接诊断');
const successfulFetch = globalThis.fetch;
for (const [status, state] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'incompatible'], [502, 'error']]) {
  globalThis.fetch = async () => ({ status, json: async () => ({}) });
  const result = await send({ type: 'cf-check' }, settingsSender);
  assert.equal(result.value.state, state);
  assert.equal(JSON.stringify(result).includes(token), false);
}
globalThis.fetch = async () => { throw new Error('offline'); };
assert.equal((await send({ type: 'cf-check' }, settingsSender)).value.state, 'unavailable');
globalThis.fetch = successfulFetch;
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
