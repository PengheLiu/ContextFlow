import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { desktopPaths, nativeManifest, chromeHostFile } from '../desktop/platform.mjs';
import { validateRequest, encodeNative, decodeNative } from '../desktop/protocol.mjs';
import { diagnosticReport } from '../desktop/diagnostics.mjs';

test('macOS and Windows own independent platform locations but retain existing data', () => {
  const mac = desktopPaths({ platform: 'darwin', home: '/Users/test', env: {} });
  assert.equal(mac.data, '/Users/test/.contextflow');
  const win = desktopPaths({ platform: 'win32', home: 'C:\\Users\\中文', env: { LOCALAPPDATA: 'D:\\Local' } });
  assert.equal(win.data, 'C:\\Users\\中文\\.contextflow'); assert.equal(win.state, 'D:\\Local\\ContextFlow');
  assert.match(chromeHostFile({ platform: 'win32', resources: 'C:\\ContextFlow\\resources' }), /native-messaging\.json$/);
});
test('Production native manifest allowlists the store extension only', () => {
  const manifest = nativeManifest('/Applications/ContextFlow.app/Contents/MacOS/ContextFlow');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://aemncphfnlpbhlddifhohpgegejjejfm/']);
  assert.equal(nativeManifest('/dev', { development: true }).allowed_origins.length, 2);
});
test('Desktop IPC service proxy rejects arbitrary URLs, methods and traversal', () => {
  assert.equal(validateRequest('/agents/detect?fresh=1').method, 'GET');
  assert.equal(validateRequest('/llm/test', { method: 'POST', body: '{}' }).body, '{}');
  for (const path of ['https://evil.test/config', '//evil.test/health', '/config/../health', '/jobs/%2e%2e', '/health#x', '/events']) assert.throws(() => validateRequest(path));
  assert.throws(() => validateRequest('/config', { method: 'PATCH' }));
  assert.throws(() => validateRequest('/config', { method: 'POST', body: {} }));
});
test('Native protocol handles fragmented UTF-8 messages and bounds memory', () => {
  const data = encodeNative({ label: 'Chrome · 阅读' });
  assert.equal(decodeNative(data.subarray(0, 2)), null);
  assert.equal(decodeNative(data.subarray(0, 5)), null);
  assert.equal(decodeNative(data).value.label, 'Chrome · 阅读');
  const invalid = Buffer.alloc(4); invalid.writeUInt32LE(2 ** 30); assert.throws(() => decodeNative(invalid), /过大/);
});
test('Diagnostic export allowlists data rather than deleting a few known secrets', () => {
  const secret = 'PRIVATE_URL_PATH_API_KEY';
  const report = diagnosticReport({ version: '1.0.0', dataDir: secret, pairings: [{ label: secret, token: secret }],
    service: { state: secret, message: secret, health: { serviceVersion: secret, stats: { total: 3, url: secret }, jobs: { running: 1, label: secret } } } });
  assert.ok(!JSON.stringify(report).includes(secret)); assert.equal(report.records.total, 3); assert.equal(report.tasks.running, 1);
});
test('Desktop ships a sandboxed local UI with narrow preload and accessible states', () => {
  const html = readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html), document = dom.window.document;
  assert.match(document.querySelector('[http-equiv="Content-Security-Policy"]').content, /connect-src 'none'/);
  assert.equal(document.querySelectorAll('nav [data-page]').length, 4);
  assert.equal(document.querySelector('#toast').getAttribute('aria-live'), 'polite');
  const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.ok(!preload.includes('send:')); assert.ok(!preload.includes('token:'));
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /sandbox: true/); assert.match(main, /contextIsolation: true/); assert.match(main, /nodeIntegration: false/);
  dom.window.close();
});
