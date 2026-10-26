import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleSession } from '../src/skill/article-session.js';

function fixture() {
  let href = 'a'; const made = [], errors = [];
  const session = articleSession({ href: () => href, keyOf: value => value,
    host: { addEventListener() {}, removeEventListener() {} },
    onError: (error, retry) => errors.push({ error, retry }),
    create: options => {
      const app = { key: href, url: href, starts: 0, saves: 0, panel: { open: options?.initialPanelOpen ?? true },
        async start() { this.starts++; this.retired = false; }, async flushForNavigation() { this.saves++; if (this.fail) throw new Error('disk full'); await this.wait; },
        suspend() { this.suspended = true; }, deactivate() { this.retired = true; }, navigationFailed() {},
        hasBackgroundWork() { return this.busy; }, stop() { this.stopped = true; },
      }; made.push(app); return app;
    },
  });
  return { session, made, errors, navigate: value => { href = value; return session.checkArticle(); } };
}
test('SPA switches only after old drafts are durable and a stable facade follows the visible article', async () => {
  const f = fixture(); await f.session.start(); const a = f.session.currentArticle;
  let release; a.wait = new Promise(resolve => { release = resolve; });
  const open = () => 'library'; f.session.openReadingLibrary = open;
  const transition = f.navigate('b'); await Promise.resolve();
  assert.equal(f.session.key, 'a'); assert.equal(a.suspended, true);
  release(); await transition;
  assert.equal(f.session.key, 'b'); assert.equal(a.key, 'a'); assert.equal(a.url, 'a'); assert.equal(a.retired, true);
  assert.equal(f.session.openReadingLibrary(), 'library'); assert.equal(f.session.panel.open, true);
  f.session.disposeSession();
});
test('save failure retains the old article and permits an explicit retry without losing drafts', async () => {
  const f = fixture(); await f.session.start(); const a = f.session.currentArticle; a.fail = true;
  await f.navigate('b'); assert.equal(f.made.length, 1); assert.equal(f.session.key, 'a'); assert.equal(a.retired, false);
  assert.match(f.errors[0].error.message, /disk full/);
  a.fail = false; await f.errors[0].retry(); assert.equal(f.session.key, 'b'); f.session.disposeSession();
});
test('rapid routes collapse to the final article; back reuses an in-flight owner without a second submission', async () => {
  const f = fixture(); await f.session.start(); const a = f.session.currentArticle; a.busy = true;
  let release; a.wait = new Promise(resolve => { release = resolve; });
  const transition = f.navigate('b'); await Promise.resolve(); await Promise.resolve();
  const following = f.navigate('c'); release(); await Promise.all([transition, following]);
  assert.deepEqual(f.made.map(app => app.key), ['a', 'c']);
  a.wait = null; await f.navigate('a'); assert.equal(f.session.currentArticle, a); assert.equal(a.starts, 2);
  assert.equal(f.made.length, 2); f.session.disposeSession();
});
test('ordinary anchors do not require a new session and disposal removes the route listeners', async () => {
  let href = 'a#one', disposed = 0; const listeners = new Map();
  const session = articleSession({ href: () => href, keyOf: value => value.split('#')[0],
    host: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) },
    create: () => ({ key: 'a', start() {}, stop() { disposed++; } }),
  });
  await session.start(); href = 'a#two'; await session.checkArticle(); assert.equal(listeners.size, 3);
  session.disposeSession(); assert.equal(disposed, 1); assert.equal(listeners.size, 0);
});

function startupFixture() {
  let href = 'a', interval;
  const made = [], errors = [], failures = new Map(), gates = new Map(), listeners = new Map();
  const session = articleSession({ href: () => href, keyOf: value => value,
    host: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
      setInterval(fn) { interval = fn; return { unref() {} }; }, clearInterval() { interval = null; } },
    onError: (error, retry, app, phase) => errors.push({ error, retry, app, phase }),
    create: () => {
      const app = { key: href, starts: 0, saves: 0, stops: 0, panel: { open: true },
        async start() { this.starts++; await gates.get(this.key)?.promise; if (failures.has(this.key)) throw failures.get(this.key); this.active = true; },
        async flushForNavigation() { this.saves++; await this.flushGate?.promise; },
        suspend() { this.suspended = true; }, deactivate() { this.active = false; },
        stop() { this.stops++; this.stopped = true; }, hasBackgroundWork() { return false; },
      }; made.push(app); return app;
    },
  });
  return { session, made, errors, failures, gates, listeners, tick: () => interval?.(), navigate: value => { href = value; return session.checkArticle(); } };
}
function gate() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

test('an initial startup failure resolves false and explicit same-article retry initializes successfully', async () => {
  const f = startupFixture(); f.failures.set('a', new Error('private storage unavailable'));
  assert.equal(await f.session.start(), false);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].phase, 'startup'); assert.equal(f.errors[0].app, f.made[0]);
  await f.tick(); assert.equal(f.made[0].starts, 1, 'the route timer must not repeatedly retry the same failed storage');
  f.failures.delete('a'); await f.errors[0].retry();
  assert.equal(await f.session.currentArticle.ready, true); assert.equal(f.made[0].starts, 2); assert.equal(f.made[0].active, true);
  f.session.disposeSession();
});

test('a next-article startup failure can retry in place and a later failed article does not strand route navigation', async () => {
  const f = startupFixture(); await f.session.start();
  f.failures.set('b', new Error('temporary IndexedDB failure'));
  await f.navigate('b'); assert.equal(f.session.key, 'b'); assert.equal(await f.session.currentArticle.ready, false);
  assert.equal(f.errors[0].phase, 'startup');
  f.failures.delete('b'); await f.errors[0].retry();
  assert.equal(f.session.currentArticle.starts, 2); assert.equal(await f.session.currentArticle.ready, true);
  f.failures.set('c', new Error('another storage failure')); await f.navigate('c');
  assert.equal(await f.session.currentArticle.ready, false);
  await f.navigate('d'); assert.equal(f.session.key, 'd'); assert.equal(await f.session.currentArticle.ready, true);
  assert.equal(f.errors.length, 2); f.session.disposeSession();
});

test('disposing before the startup microtask never starts an App and resolves readiness as false', async () => {
  const f = startupFixture(), ready = f.session.start(); f.session.disposeSession();
  assert.equal(await ready, false); assert.equal(f.made[0].starts, 0); assert.equal(f.made[0].stops, 1);
  assert.equal(f.listeners.size, 0); assert.equal(f.errors.length, 0);
});

test('disposal during pending initial startup prevents a waiting route switch from creating another App', async () => {
  const f = startupFixture(), pending = gate(); f.gates.set('a', pending);
  const ready = f.session.start(); await Promise.resolve();
  const transition = f.navigate('b'); f.session.disposeSession(); pending.resolve();
  await Promise.all([ready, transition]);
  assert.deepEqual(f.made.map(app => app.key), ['a']);
  assert.equal(f.made[0].saves, 0, 'a disposed session must not flush a route that no longer exists');
  assert.equal(f.errors.length, 0);
});

test('disposal during a pending route flush prevents creation and startup of the next article', async () => {
  const f = startupFixture(); await f.session.start();
  f.made[0].flushGate = gate(); const transition = f.navigate('b'); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.made[0].saves, 1); f.session.disposeSession(); f.made[0].flushGate.resolve(); await transition;
  assert.deepEqual(f.made.map(app => app.key), ['a']); assert.equal(f.errors.length, 0);
});

test('a pending startup rejection after disposal stays handled and never restores an error notice', async () => {
  const f = startupFixture(), pending = gate(); f.gates.set('a', pending);
  const ready = f.session.start(); await Promise.resolve();
  const transition = f.navigate('b'); f.session.disposeSession(); pending.reject(new Error('storage closed during disposal'));
  assert.equal(await ready, false); await transition;
  assert.equal(f.errors.length, 0); assert.deepEqual(f.made.map(app => app.key), ['a']);
});
