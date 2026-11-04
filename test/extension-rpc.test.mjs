import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, sendRuntimeMessage, EXTENSION_CONTEXT_INVALIDATED } from '../src/ext/rpc.js';

async function isolated(run) {
  const previous = globalThis.chrome, set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (fn, ms) => { const id = set(fn, ms); timers.add(id); return id; };
  globalThis.clearTimeout = id => { timers.delete(id); clear(id); };
  try { await run(); assert.equal(timers.size, 0, 'every settled message must clear its timeout'); }
  finally {
    for (const id of timers) clear(id);
    globalThis.chrome = previous; globalThis.setTimeout = set; globalThis.clearTimeout = clear;
  }
}
const fatal = error => error.code === EXTENSION_CONTEXT_INVALIDATED
  && /复制或下载.*再刷新/.test(error.message) && !/sendMessage|TypeError/.test(error.message);

test('missing Chrome/runtime/sendMessage becomes an actionable context-loss error without a dangling timer', async () => isolated(async () => {
  for (const chrome of [undefined, {}, { runtime: {} }]) {
    globalThis.chrome = chrome;
    await assert.rejects(request({ type: 'cf-offline', method: 'saveOfflineEvents', args: [[]] }), fatal);
  }
  globalThis.chrome = { get runtime() { throw new Error('Extension context invalidated.'); } };
  await assert.rejects(request({ type: 'cf-ui-snapshot' }), fatal);
}));

test('synchronous invalidation is caught and clears an already-armed request timeout', async () => isolated(async () => {
  globalThis.chrome = { runtime: { sendMessage() { throw new Error('Extension context invalidated.'); } } };
  await assert.rejects(request({ type: 'cf-ui-write', key: 'contextflow:ui', value: 'draft' }), fatal);
}));

test('runtime disappearing or its lastError getter throwing during callback never escapes as a TypeError', async () => isolated(async () => {
  for (const mode of ['missing', 'getter']) {
    let callback;
    const runtime = { sendMessage(_message, done) { callback = done; } };
    globalThis.chrome = { runtime };
    const pending = sendRuntimeMessage({ type: 'cf-offline' });
    const rejected = assert.rejects(pending, fatal);
    if (mode === 'missing') globalThis.chrome.runtime = undefined;
    else Object.defineProperty(runtime, 'lastError', { get() { throw new Error('Extension context invalidated.'); } });
    assert.doesNotThrow(() => callback(undefined));
    await rejected;
  }
}));

test('temporary background failures permit a normal retry and are distinct from extension replacement', async () => isolated(async () => {
  const runtime = { lastError: null, sendMessage(_message, done) { done(undefined); } };
  globalThis.chrome = { runtime };
  runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
  await assert.rejects(request({ type: 'cf-ui-snapshot' }), error => error.code === 'EXTENSION_BACKGROUND_UNAVAILABLE' && /重试/.test(error.message));
  runtime.lastError = null;
  runtime.sendMessage = (_message, done) => done({ ok: true, value: { recovered: true } });
  assert.deepEqual(await request({ type: 'cf-ui-snapshot' }), { recovered: true });
}));

test('missing acknowledgement is never success and durable quota errors preserve their useful reason', async () => isolated(async () => {
  const runtime = { sendMessage(_message, done) { done(undefined); } };
  globalThis.chrome = { runtime };
  await assert.rejects(request({ type: 'cf-offline' }), error => error.code === 'EXTENSION_BACKGROUND_UNAVAILABLE');
  runtime.sendMessage = (_message, done) => done({ ok: false, error: '浏览器存储配额不足', code: 'QUOTA' });
  await assert.rejects(request({ type: 'cf-offline' }), error => error.code === 'QUOTA' && /配额不足/.test(error.message));
}));

test('raw fetch envelopes, encoded images and duplicate/late callbacks retain the established transport contract', async () => isolated(async () => {
  const runtime = { sendMessage(message, done) {
    assert.equal(message.type, 'cf-fetch'); done({ status: 200, body: { ok: true } }); done(undefined);
  } };
  globalThis.chrome = { runtime };
  assert.deepEqual(await sendRuntimeMessage({ type: 'cf-fetch' }), { status: 200, body: { ok: true } });
  runtime.sendMessage = (message, done) => {
    assert.equal(message.blob.__contextflowBlob, true);
    done({ ok: true, value: message.blob });
  };
  const blob = await request({ type: 'cf-offline', blob: new Blob(['draft-image'], { type: 'image/png' }) });
  assert.equal(await blob.text(), 'draft-image');
}));

test('a real deadline rejects honestly, and invalidation while waiting uses the preservation guidance', async () => isolated(async () => {
  let callback, reads = 0;
  globalThis.chrome = { runtime: { sendMessage(_message, done) { callback = done; }, get lastError() { reads++; return undefined; } } };
  await assert.rejects(sendRuntimeMessage({ type: 'cf-offline' }, { timeoutMs: 5 }), error => error.code === 'EXTENSION_TIMEOUT');
  callback({ ok: true }); // a late acknowledgement cannot settle the rejected call again
  assert.equal(reads, 1, 'late callbacks must still consume lastError to avoid unchecked runtime warnings');
  const pending = sendRuntimeMessage({ type: 'cf-offline' }, { timeoutMs: 5 });
  const rejected = assert.rejects(pending, fatal);
  globalThis.chrome.runtime = undefined;
  await rejected;
}));
