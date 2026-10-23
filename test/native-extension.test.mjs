import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Only trusted settings can pair the desktop; credentials remain in SW storage', async () => {
  const id = 'a'.repeat(32), token = 's'.repeat(43), stored = {}, listeners = {};
  let nativeCalls = 0, headers;
  globalThis.chrome = {
    runtime: { id, getURL: path => `chrome-extension://${id}/${path}`,
      onMessage: { addListener: listener => { listeners.message = listener; } },
      onInstalled: { addListener: () => {} },
      connectNative: _host => {
        nativeCalls++; let messageListener;
        return {
          onMessage: { addListener: listener => { messageListener = listener; } },
          onDisconnect: { addListener: () => {} }, disconnect() {},
          postMessage(request) {
            assert.equal(request.type, 'pair'); assert.equal(request.consent, true);
            queueMicrotask(() => messageListener({ ok: true, protocolVersion: 1, token, baseUrl: 'http://127.0.0.1:7317' }));
          },
        };
      } },
    storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: stored[key] }), set: async values => Object.assign(stored, values) } },
    tabs: { query: async () => [], sendMessage: async () => {} }, action: { onClicked: { addListener: () => {} } },
  };
  globalThis.fetch = async (_url, options) => { headers = options.headers; return { status: 200, json: async () => ({ ok: true, extensionPaired: true }) }; };
  await import('../extension/sw.js');
  const settings = { id, url: `chrome-extension://${id}/options.html` };
  const page = { id, url: 'https://example.test/', tab: { id: 1 }, frameId: 0 };
  const send = (message, sender) => new Promise(resolve => listeners.message(message, sender, resolve));
  assert.equal((await send({ type: 'cf-connect-native', consent: true }, page)).ok, false);
  assert.equal((await send({ type: 'cf-connect-native', consent: false }, settings)).ok, false); assert.equal(nativeCalls, 0);
  const paired = await send({ type: 'cf-connect-native', consent: true }, settings);
  assert.equal(paired.ok, true); assert.equal(JSON.stringify(paired).includes(token), false);
  assert.equal(stored.connection.token, token); assert.equal(headers['X-ContextFlow-Instance'], stored.desktopInstanceId);
  assert.equal(headers['X-ContextFlow-Extension'], id);
  const firstId = stored.desktopInstanceId;
  await send({ type: 'cf-connect-native', consent: true }, settings); assert.equal(stored.desktopInstanceId, firstId);
  const status = await send({ type: 'cf-status' }, settings);
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal(status.value.source, 'desktop', '设置页应知道恢复桌面端还是旧命令行服务，不暴露凭据');
});
