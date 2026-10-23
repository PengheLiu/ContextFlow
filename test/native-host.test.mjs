import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNativeHost } from '../desktop/native-host.mjs';
import { encodeNative, decodeNative } from '../desktop/protocol.mjs';

test('Native host forwards only an approved protocol request and emits framed UTF-8', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-native-host-')), bridge = join(root, 'bridge.json');
  const before = process.argv, originalFetch = globalThis.fetch;
  try {
    process.argv = ['host', 'chrome-extension://aemncphfnlpbhlddifhohpgegejjejfm/'];
    await writeFile(bridge, JSON.stringify({ port: 12345, secret: 'a'.repeat(43) }));
    let forwarded, bytes = Buffer.alloc(0), finish;
    const done = new Promise(resolve => { finish = resolve; });
    const input = new PassThrough(), output = new Writable({ write(chunk, _encoding, next) { bytes = Buffer.concat([bytes, chunk]); next(); } });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:12345/pair');
      assert.equal(options.redirect, 'error'); forwarded = JSON.parse(options.body);
      return { json: async () => ({ ok: true, token: 's'.repeat(43), protocolVersion: 1, baseUrl: 'http://127.0.0.1:7317' }) };
    };
    const app = { disableHardwareAcceleration() {}, exit: code => finish(code), isPackaged: true };
    await runNativeHost({ app, paths: { bridge }, input, output });
    const request = encodeNative({ type: 'pair', protocolVersion: 1, consent: true, instanceId: 'instance-123456789', label: 'Chrome · 阅读' });
    input.write(request.subarray(0, 3)); input.write(request.subarray(3));
    assert.equal(await done, 0); assert.equal(forwarded.label, 'Chrome · 阅读');
    assert.equal(decodeNative(bytes).value.token, 's'.repeat(43));
  } finally { process.argv = before; globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
