import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  compareVersions, validateUpdateFeed, getUpdateState, createUpdateChecker,
  UPDATE_FEED_URL, UPDATE_DOWNLOAD_URL, UPDATE_STORE_URL,
} from '../src/core/updates.js';
import { publishedUpdateFeed } from '../tools/update-feed.mjs';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const row = (version, url) => ({ version, url,
  releaseNotesUrl: `https://github.com/PengheLiu/ContextFlow/releases/tag/v${version}` });
const feed = () => ({ schemaVersion: 1,
  extension: row('1.10.0', UPDATE_STORE_URL),
  desktop: { 'darwin-arm64': row('1.2.0', UPDATE_DOWNLOAD_URL), 'win32-x64': row('1.3.0', UPDATE_DOWNLOAD_URL) },
});
const response = (value = feed(), options = {}) => ({
  ok: options.ok ?? true, url: options.url ?? UPDATE_FEED_URL, redirected: options.redirected ?? false,
  headers: { get: name => name === 'content-length' ? options.length ?? null : null },
  ...(options.body ? { body: options.body } : {}),
  text: async () => options.text ?? JSON.stringify(value),
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nextTurn = () => new Promise(done => setImmediate(done));
const extension = options => createUpdateChecker({ currentVersion: '1.9.0', kind: 'extension', timeoutMs: 100, ...options });

test('release versions compare numerically and reject ambiguous, prerelease or out-of-range values', () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('1.0.11', '1.0.2'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('65535.0.0', '65535.0.0'), 0);
  for (const invalid of ['v1.0.0', '01.0.0', '1.0', '1.0.0.1', '1.0.0-rc.1', '1.0.0+build', '1.0.0\n', '-1.0.0', '65536.0.0', '100000.0.0', null, 1]) {
    assert.throws(() => compareVersions(invalid, '1.0.0'), /格式无效/, String(invalid));
    assert.throws(() => compareVersions('1.0.0', invalid), /格式无效/, String(invalid));
  }
});

test('update availability is per channel and platform; a newer candidate is not called the latest published release', () => {
  const base = { feed: feed(), checkedAt: 12345 };
  const available = getUpdateState({ ...base, currentVersion: '1.9.0', kind: 'extension' });
  assert.equal(available.state, 'available'); assert.equal(available.latestVersion, '1.10.0');
  assert.equal(available.url, UPDATE_STORE_URL); assert.equal(available.checkedAt, 12345);
  assert.equal(getUpdateState({ ...base, currentVersion: '1.10.0', kind: 'extension' }).state, 'current');
  const ahead = getUpdateState({ ...base, currentVersion: '1.11.0', kind: 'extension' });
  assert.equal(ahead.state, 'current'); assert.match(ahead.message, /未发现比当前版本更新的已发布版本/);
  assert.doesNotMatch(ahead.message, /当前已是最新公开版本/);
  assert.equal(getUpdateState({ ...base, currentVersion: '1.1.0', kind: 'desktop', platform: 'darwin', architecture: 'arm64' }).latestVersion, '1.2.0');
  assert.equal(getUpdateState({ ...base, currentVersion: '1.2.0', kind: 'desktop', platform: 'win32', architecture: 'x64' }).latestVersion, '1.3.0');
  for (const [platform, architecture] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64']]) {
    const unsupported = getUpdateState({ ...base, currentVersion: '1.0.0', kind: 'desktop', platform, architecture });
    assert.equal(unsupported.state, 'unsupported'); assert.equal(unsupported.url, undefined);
    assert.equal(unsupported.latestVersion, undefined); assert.match(unsupported.message, /尚无.*公开安装包/);
  }
  assert.throws(() => getUpdateState({ ...base, currentVersion: '1.0.0', kind: 'arbitrary' }));
});

test('feed validation pins download destinations and release-note versions instead of trusting remote links', () => {
  assert.deepEqual(validateUpdateFeed(feed()), feed());
  for (const mutate of [
    value => { value.schemaVersion = 2; }, value => { value.desktop = []; }, value => { value.extension = null; },
    value => { value.extension.version = '1.10.0-rc1'; }, value => { value.extension.version = '01.0.0'; },
    value => { value.extension.url = 'https://example.invalid/secret'; },
    value => { value.extension.url += '?tracking=1'; }, value => { value.extension.url = `javascript:alert(1)`; },
    value => { value.desktop['darwin-arm64'].url = 'http://pengheliu.github.io/ContextFlow/download.html'; },
    value => { value.desktop['darwin-arm64'].url = `${UPDATE_DOWNLOAD_URL}#unreviewed`; },
    value => { value.extension.releaseNotesUrl = 'https://github.com/PengheLiu/ContextFlow/releases/tag/v1.9.0'; },
    value => { value.desktop['linux-x64'] = row('1.2.0', UPDATE_DOWNLOAD_URL); },
  ]) {
    const invalid = feed(); mutate(invalid); assert.throws(() => validateUpdateFeed(invalid));
  }
  for (const invalid of [null, [], 'metadata', {}]) assert.throws(() => validateUpdateFeed(invalid));
  const enriched = feed(); enriched.article = 'PRIVATE_ARTICLE_MUST_NOT_SURVIVE'; enriched.extension.extra = 'private';
  assert.deepEqual(validateUpdateFeed(enriched), feed(), 'only the bounded public schema survives validation');
});

test('the published website feed ignores candidate and unpublished platform versions', () => {
  const state = JSON.parse(readFileSync(new URL('../product/release.json', import.meta.url), 'utf8'));
  state.candidateVersion = '99.0.0';
  state.desktop.platforms['win32-arm64'] = { status: 'unpublished', version: '99.0.0' };
  const publicFeed = publishedUpdateFeed(state);
  assert.equal(publicFeed.extension.version, state.publishedExtension.version);
  assert.notEqual(publicFeed.extension.version, state.candidateVersion);
  assert.equal(publicFeed.desktop['darwin-arm64'].version, state.desktop.platforms['darwin-arm64'].version);
  assert.equal(publicFeed.desktop['win32-arm64'], undefined);
  assert.equal(JSON.stringify(publicFeed).includes('99.0.0'), false);
});

test('successful checks cache only validated public metadata and never send current version or personal state', async () => {
  let clock = 100000, saved, calls = 0;
  const notices = [];
  const checker = extension({ now: () => clock, onChange: state => notices.push(state),
    saveCache: value => { saved = value; }, fetch: async (url, init) => {
      calls++; assert.equal(url, UPDATE_FEED_URL);
      assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'redirect', 'signal']);
      assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal); return response();
    },
  });
  try {
    assert.equal(checker.snapshot().state, 'idle');
    const first = await checker.check();
    assert.equal(first.state, 'available'); assert.equal(first.checking, false); assert.equal(first.stale, false);
    assert.equal(first.checkedAt, clock);
    assert.deepEqual(saved, { schemaVersion: 1, checkedAt: clock, feed: feed() });
    assert.equal(notices[0].checking, true); assert.equal(notices.at(-1).state, 'available');
    const detached = checker.snapshot(); detached.state = 'tampered';
    assert.equal(checker.snapshot().state, 'available', 'a view cannot mutate checker state');
    clock += SIX_HOURS - 1; await checker.check(); assert.equal(calls, 1);
    clock++; await checker.check(); assert.equal(calls, 2);
    await checker.check({ force: true }); assert.equal(calls, 3);
  } finally { checker.dispose(); }
});

test('manual checks coalesce while cache loading and while fetching, including forced concurrent requests', async () => {
  const load = deferred(), request = deferred(); let calls = 0, loads = 0;
  const checker = extension({ loadCache: () => { loads++; return load.promise; }, fetch: () => { calls++; return request.promise; } });
  try {
    const first = checker.check(), second = checker.check({ force: true });
    assert.equal(first, second); assert.equal(loads, 1); assert.equal(calls, 0);
    load.resolve(null); await nextTurn(); assert.equal(calls, 1);
    assert.equal(checker.check({ force: true }), first);
    request.resolve(response());
    assert.equal((await first).state, 'available'); assert.equal(calls, 1);
  } finally { checker.dispose(); }
});

test('a recent valid cache skips the network; expired cache remains available while a refresh is attempted', async () => {
  const clock = 100000000, recent = { schemaVersion: 1, checkedAt: clock - 10, feed: feed() };
  const cached = extension({ now: () => clock, loadCache: () => recent, fetch: () => { throw new Error('must not fetch'); } });
  try {
    const result = await cached.check(); assert.equal(result.state, 'available'); assert.equal(result.checkedAt, clock - 10); assert.equal(result.stale, false);
  } finally { cached.dispose(); }
  let calls = 0;
  const stale = extension({ now: () => clock, loadCache: () => ({ ...recent, checkedAt: clock - SIX_HOURS }),
    fetch: () => { calls++; throw new Error('PRIVATE_GATEWAY_OR_ERROR_URL'); } });
  try {
    const result = await stale.check(); assert.equal(calls, 1); assert.equal(result.state, 'available');
    assert.equal(result.stale, true); assert.equal(result.checking, false); assert.equal(result.latestVersion, '1.10.0');
    assert.match(result.checkError, /暂时无法检查更新/); assert.equal(result.checkedAt, clock - SIX_HOURS);
    assert.equal(JSON.stringify(result).includes('PRIVATE_GATEWAY_OR_ERROR_URL'), false);
  } finally { stale.dispose(); }
});

test('network errors never erase a previously available release or manufacture a current-version result', async () => {
  let calls = 0, saves = 0;
  const checker = extension({ fetch: async () => { if (++calls === 1) return response(); throw new Error('https://private.example/token-secret'); },
    saveCache: () => { saves++; } });
  try {
    const good = await checker.check(); const failed = await checker.check({ force: true });
    assert.equal(failed.state, 'available'); assert.equal(failed.url, good.url); assert.equal(failed.checkedAt, good.checkedAt);
    assert.equal(failed.stale, true); assert.match(failed.checkError, /暂时无法检查更新/); assert.equal(saves, 1);
    assert.doesNotMatch(JSON.stringify(failed), /private\.example|token-secret/);
  } finally { checker.dispose(); }
  const firstFailure = extension({ fetch: () => { throw new Error('private error'); } });
  try { const state = await firstFailure.check(); assert.equal(state.state, 'error'); assert.equal(state.latestVersion, undefined); }
  finally { firstFailure.dispose(); }
});

test('broken, invalid or future-dated caches are ignored rather than suppressing fresh checks', async () => {
  const clock = 100000;
  for (const cached of [null, {}, { schemaVersion: 2, checkedAt: clock - 1, feed: feed() },
    { schemaVersion: 1, checkedAt: clock + 1, feed: feed() }, { schemaVersion: 1, checkedAt: 0, feed: feed() },
    { schemaVersion: 1, checkedAt: '99999', feed: feed() }, { schemaVersion: 1, checkedAt: clock - 1, feed: {} },
    { schemaVersion: 1, checkedAt: clock - 1, feed: { ...feed(), extension: row('1.0.0', 'https://invalid.example') } },
  ]) {
    let calls = 0;
    const checker = extension({ now: () => clock, loadCache: () => cached, fetch: () => { calls++; return response(); } });
    try { const state = await checker.check(); assert.equal(calls, 1); assert.equal(state.checkedAt, clock); assert.equal(state.state, 'available'); }
    finally { checker.dispose(); }
  }
  const checker = extension({ loadCache: () => { throw new Error('corrupt private file'); }, saveCache: () => { throw new Error('disk full'); }, fetch: () => response() });
  try { assert.equal((await checker.check()).state, 'available'); } finally { checker.dispose(); }
});

test('oversized, redirected and malformed responses fail without caching or exposing remote error text', async () => {
  const badResponses = [
    response({}, { ok: false }), response(feed(), { redirected: true }), response(feed(), { url: 'https://evil.example/secret' }),
    response(feed(), { length: '65537' }), response(feed(), { length: 'invalid' }),
    response(feed(), { text: 'x'.repeat(65537) }), response(feed(), { text: '中'.repeat(21846) }),
    response(feed(), { text: 'not-json PRIVATE_RESPONSE_SECRET' }), response({ ...feed(), schemaVersion: 9 }),
  ];
  for (const bad of badResponses) {
    let saves = 0;
    const checker = extension({ fetch: () => bad, saveCache: () => { saves++; } });
    try {
      const state = await checker.check(); assert.equal(state.state, 'error'); assert.equal(state.latestVersion, undefined);
      assert.equal(saves, 0); assert.doesNotMatch(JSON.stringify(state), /evil\.example|PRIVATE_RESPONSE_SECRET|not-json/);
    } finally { checker.dispose(); }
  }
});

test('stream limits count actual bytes even without content-length and cancel oversized bodies', async () => {
  let canceled = false, released = false, saves = 0;
  const body = { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(65537) }),
    cancel: async () => { canceled = true; }, releaseLock: () => { released = true; } }) };
  const checker = extension({ fetch: () => response({}, { body }), saveCache: () => { saves++; } });
  try {
    assert.equal((await checker.check()).state, 'error'); assert.equal(canceled, true); assert.equal(released, true); assert.equal(saves, 0);
  } finally { checker.dispose(); }
  const encoded = new TextEncoder().encode(JSON.stringify(feed()));
  const valid = extension({ fetch: () => response({}, { body: new ReadableStream({ start(controller) { controller.enqueue(encoded.subarray(0, 10)); controller.enqueue(encoded.subarray(10)); controller.close(); } }) }) });
  try { assert.equal((await valid.check()).state, 'available'); } finally { valid.dispose(); }
});

test('timeout aborts the request, ignores late success and remains retryable', async () => {
  const waiting = deferred(); let signal, calls = 0, saves = 0;
  const checker = extension({ timeoutMs: 5, fetch: (_url, init) => { signal = init.signal; return ++calls === 1 ? waiting.promise : response(); },
    saveCache: () => { saves++; } });
  try {
    assert.equal((await checker.check()).state, 'error'); assert.equal(signal.aborted, true); assert.equal(saves, 0);
    waiting.resolve(response()); await nextTurn();
    assert.equal(checker.snapshot().state, 'error'); assert.equal(saves, 0);
    assert.equal((await checker.check({ force: true })).state, 'available'); assert.equal(saves, 1);
  } finally { checker.dispose(); }
});

test('disposing a check aborts in-flight work, never notifies or saves again, and prevents subsequent requests', async () => {
  const waiting = deferred(); const notices = []; let calls = 0, signal, saves = 0;
  const checker = extension({ timeoutMs: 20, onChange: state => notices.push(state), fetch: (_url, init) => { calls++; signal = init.signal; return waiting.promise; },
    saveCache: () => { saves++; } });
  const pending = checker.check(); await nextTurn();
  assert.equal(calls, 1); checker.dispose(); const count = notices.length;
  assert.equal(signal.aborted, true);
  waiting.resolve(response()); await pending; await nextTurn();
  assert.equal(saves, 0); assert.equal(notices.length, count);
  await checker.check({ force: true }); assert.equal(calls, 1); assert.equal(notices.length, count);
  const cache = deferred(); let cacheFetches = 0;
  const duringLoad = extension({ loadCache: () => cache.promise, fetch: () => { cacheFetches++; return response(); } });
  const loading = duringLoad.check(); duringLoad.dispose(); cache.resolve(null); await loading;
  assert.equal(cacheFetches, 0);
});
