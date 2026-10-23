import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { approveBrowserPairing } from '../desktop/pairing-approval.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = () => {
  const request = new EventEmitter(), response = new EventEmitter(), dialog = deferred();
  let grants = 0, signal, timer, clock = 100, cleared = 0;
  const run = () => approveBrowserPairing({ request, response, ask: value => { signal = value; return dialog.promise; },
    grant: () => { grants++; return 'test-grant'; }, now: () => clock, timeoutMs: 65,
    setTimer: callback => { timer = callback; return 42; }, clearTimer: value => { assert.equal(value, 42); cleared++; } });
  return { request, response, dialog, run, expire: () => { clock += 65; timer(); },
    jumpPastDeadline: () => { clock += 66; }, get grants() { return grants; }, get signal() { return signal; }, get cleared() { return cleared; } };
};
test('a live explicit approval persists once; normal request body close is not cancellation', async () => {
  const f = fixture(), result = f.run(); await Promise.resolve();
  f.request.emit('close'); f.dialog.resolve({ response: 1 });
  assert.deepEqual(await result, { ok: true, token: 'test-grant' }); assert.equal(f.grants, 1);
  assert.equal(f.signal.aborted, false); assert.equal(f.cleared, 1);
  assert.equal(f.request.listenerCount('aborted'), 0); assert.equal(f.response.listenerCount('close'), 0);
});
test('cancel does not persist or invent an authorization', async () => {
  const f = fixture(), result = f.run(); f.dialog.resolve({ response: 0 });
  assert.match((await result).error, /已取消/); assert.equal(f.grants, 0);
});
test('deadline aborts the dialog, releases the request and ignores a late approval', async () => {
  const f = fixture(), result = f.run(); await Promise.resolve(); f.expire();
  assert.match((await result).error, /已超时/); assert.equal(f.signal.aborted, true);
  f.dialog.resolve({ response: 1 }); await Promise.resolve(); assert.equal(f.grants, 0);
});
test('aborted request or closed response never leaves a ghost browser grant', async () => {
  for (const target of ['request', 'response']) {
    const f = fixture(), result = f.run(); await Promise.resolve();
    f[target].emit(target === 'request' ? 'aborted' : 'close');
    assert.match((await result).error, /连接已结束/); assert.equal(f.signal.aborted, true);
    f.dialog.resolve({ response: 1 }); await Promise.resolve(); assert.equal(f.grants, 0);
  }
});
test('late approval is rejected even if the event loop has not delivered the timeout callback', async () => {
  const f = fixture(), result = f.run(); await Promise.resolve(); f.jumpPastDeadline(); f.dialog.resolve({ response: 1 });
  assert.match((await result).error, /已超时/); assert.equal(f.grants, 0);
});
test('an already disconnected request does not open a dialog; real dialog failures still propagate', async () => {
  const f = fixture(); f.response.destroyed = true;
  assert.equal((await f.run()).ok, false); assert.equal(f.signal, undefined); assert.equal(f.grants, 0);
  const failed = fixture(), result = failed.run(); failed.dialog.reject(new Error('fixture-dialog-failed'));
  await assert.rejects(result, /fixture-dialog-failed/); assert.equal(failed.grants, 0);
});
test('the real bridge uses the bounded approval helper and checks its lock after reading the body', () => {
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /approveBrowserPairing\(\{ request: req, response: res,/);
  assert.match(main, /grant: \(\) => \{\s+if \(quitting \|\| service.state !== 'running'\)/);
  assert.match(main, /finally \{ if \(ownsPairing\) pairing = false; \}/);
  assert.match(main, /const request = JSON.parse\(buffer\);[\s\S]*?if \(pairing\) return reply\(409/);
  assert.match(main, /cancelId: 0, signal,/);
});
