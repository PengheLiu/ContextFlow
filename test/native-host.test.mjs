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
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ ok: true, service: 'running' }) };
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

async function readinessFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'cf-native-readiness-')), bridge = join(root, 'bridge.json');
  const before = process.argv, originalFetch = globalThis.fetch;
  try {
    process.argv = ['host', 'chrome-extension://aemncphfnlpbhlddifhohpgegejjejfm/'];
    await writeFile(bridge, JSON.stringify({ port: 12345, secret: 'a'.repeat(43) }));
    let bytes = Buffer.alloc(0), finish;
    const done = new Promise(resolve => { finish = resolve; });
    const input = new PassThrough(), output = new Writable({ write(chunk, _encoding, next) { bytes = Buffer.concat([bytes, chunk]); next(); } });
    const app = { disableHardwareAcceleration() {}, exit: code => finish(code), isPackaged: true };
    await run({ app, bridge, input, output, done, result: () => decodeNative(bytes)?.value });
  } finally { process.argv = before; globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
}
test('Cold wake waits for the owned core before making the one explicit pairing request', async () => {
  await readinessFixture(async ({ app, bridge, input, output, done, result }) => {
    let checks = 0, pairs = 0;
    globalThis.fetch = async url => {
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ ok: true, service: ++checks < 3 ? 'starting' : 'running' }) };
      pairs++; return { json: async () => checks >= 3 ? { ok: true, token: 'fixture' } : { ok: false, error: 'still starting' } };
    };
    await runNativeHost({ app, paths: { bridge }, input, output, wait: async () => {}, spawnProcess: () => { throw new Error('must not start a real app'); } });
    input.write(encodeNative({ type: 'pair', protocolVersion: 1, consent: true, instanceId: 'readiness-123456789' }));
    await done; assert.equal(result().ok, true); assert.equal(checks, 3); assert.equal(pairs, 1);
  });
});
test('Readiness has a deadline and a canceled approval is never replayed', async () => {
  await readinessFixture(async ({ app, bridge, input, output, done, result }) => {
    let clock = 0, pairs = 0;
    globalThis.fetch = async url => url.endsWith('/status')
      ? { ok: true, json: async () => ({ ok: true, service: 'starting' }) }
      : (++pairs, { json: async () => ({ ok: false, error: 'unexpected pair' }) });
    await runNativeHost({ app, paths: { bridge }, input, output, now: () => clock, readinessTimeoutMs: 20, wait: async () => { clock += 10; } });
    input.write(encodeNative({ type: 'pair', protocolVersion: 1, consent: true, instanceId: 'readiness-123456789' }));
    await done; assert.equal(result().ok, false); assert.match(result().error, /启动|就绪|未响应/); assert.equal(pairs, 0);
  });
  await readinessFixture(async ({ app, bridge, input, output, done, result }) => {
    let pairs = 0;
    globalThis.fetch = async url => url.endsWith('/status') ? { ok: true, json: async () => ({ ok: true, service: 'running' }) }
      : (++pairs, { json: async () => ({ ok: false, error: '已取消连接' }) });
    await runNativeHost({ app, paths: { bridge }, input, output });
    input.write(encodeNative({ type: 'pair', protocolVersion: 1, consent: true, instanceId: 'readiness-123456789' }));
    await done; assert.match(result().error, /取消/); assert.equal(pairs, 1);
  });
});
test('Closing the browser native port aborts an outstanding approval without emitting a credential', async () => {
  await readinessFixture(async ({ app, bridge, input, output, done, result }) => {
    let pairSignal, reached; const pairing = new Promise(resolve => { reached = resolve; });
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/status')) return { ok: true, json: async () => ({ ok: true, service: 'running' }) };
      pairSignal = options.signal; reached();
      return new Promise((_resolve, reject) => pairSignal.addEventListener('abort', () => reject(new Error('fixture disconnected')), { once: true }));
    };
    await runNativeHost({ app, paths: { bridge }, input, output });
    input.write(encodeNative({ type: 'pair', protocolVersion: 1, consent: true, instanceId: 'readiness-123456789' }));
    await pairing; input.end(); await done;
    assert.equal(pairSignal.aborted, true); assert.equal(result(), undefined);
  });
});
