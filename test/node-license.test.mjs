import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { NODE_LICENSE_VERSION, NODE_LICENSE_SHA256, createLicenseInstaller, installNodeLicense } from '../tools/node-license.mjs';

const bytes = Buffer.from('Node.js test-only license fixture.\nCopyright test fixture authors.\n');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const install = createLicenseInstaller({ version: '24.22.1', sha256: sha256(bytes) });
function fixture() {
  // Canonicalize the OS's own /var -> /private/var alias. Paths beneath this
  // freshly created root must not contain any further symbolic links.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'contextflow-node-license-')));
  return { root, cacheDir: join(root, 'cache'), output: join(root, 'runtime', 'NODE-LICENSE'),
    close: () => rmSync(root, { recursive: true, force: true }) };
}
const cachedFile = sample => join(sample.cacheDir, `node-${NODE_LICENSE_VERSION}-LICENSE`);
const noTemporaryFiles = sample => assert.deepEqual(readdirSync(sample.cacheDir).filter(file => file.startsWith('.node-license-')), []);

test('production Node license pins cannot be overridden by installer arguments', async () => {
  assert.equal(NODE_LICENSE_VERSION, '24.22.1');
  assert.equal(NODE_LICENSE_SHA256, '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace');
  const sample = fixture();
  try {
    await assert.rejects(() => installNodeLicense({ ...sample, sourceBytes: bytes, version: '24.22.1', sha256: sha256(bytes) }), { code: 'NODE_LICENSE_INVALID' });
    assert.equal(existsSync(sample.output), false); assert.equal(existsSync(cachedFile(sample)), false);
    const prepare = readFileSync(new URL('../tools/prepare-desktop.mjs', import.meta.url), 'utf8');
    assert.match(prepare, /NODE_LICENSE_VERSION, installNodeLicense/);
    assert.match(prepare, /sourceBytes: readFileSync\(join\(unpacked, 'LICENSE'\)\)/);
    assert.match(prepare, /'tools\/node-license\.mjs'/, 'license verification implementation is included in stale-build source metadata');
    assert.doesNotMatch(prepare, /await fetch\(`https:\/\/raw\.githubusercontent\.com\/nodejs\/node/);
  } finally { sample.close(); }
});

test('Mac verified-archive license seeds the shared cache and a subsequent Windows install is offline', async () => {
  const sample = fixture(); let fetched = 0;
  try {
    const result = await install({ ...sample, sourceBytes: bytes, fetcher: () => { fetched++; throw new Error('must not fetch'); } });
    assert.equal(result.version, NODE_LICENSE_VERSION); assert.equal(result.sha256, sha256(bytes));
    assert.deepEqual(readFileSync(sample.output), bytes); assert.deepEqual(readFileSync(cachedFile(sample)), bytes);
    const inode = statSync(cachedFile(sample)).ino;
    const windowsOutput = join(sample.root, 'windows-runtime', 'NODE-LICENSE');
    await install({ cacheDir: sample.cacheDir, output: windowsOutput, fetcher: () => { fetched++; throw new Error('offline'); } });
    assert.deepEqual(readFileSync(windowsOutput), bytes); assert.equal(fetched, 0);
    assert.equal(statSync(cachedFile(sample)).ino, inode, 'a verified cache hit is reused without replacing it'); noTemporaryFiles(sample);
  } finally { sample.close(); }
});

test('uncached Windows license fetch retries at most three times, then atomically caches only verified bytes', async () => {
  const sample = fixture(); const signals = []; let calls = 0;
  try {
    await install({ ...sample, fetcher: async (url, options) => {
      assert.equal(url, 'https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE');
      assert.equal(options.redirect, 'error'); signals.push(options.signal);
      if (++calls < 3) throw new Error('https://user:network-secret@invalid.test/?token=do-not-disclose');
      return new Response(bytes, { headers: { 'content-type': 'text/plain' } });
    } });
    assert.equal(calls, 3); assert.ok(signals.every(signal => signal.aborted));
    assert.deepEqual(readFileSync(cachedFile(sample)), bytes); assert.deepEqual(readFileSync(sample.output), bytes); noTemporaryFiles(sample);
  } finally { sample.close(); }
});

test('a corrupt regular cache is never accepted and can be repaired by a verified download', async () => {
  const sample = fixture(); let calls = 0;
  try {
    mkdirSync(sample.cacheDir); writeFileSync(cachedFile(sample), 'corrupt cache');
    await install({ ...sample, fetcher: async () => { calls++; return new Response(bytes); } });
    assert.equal(calls, 1); assert.deepEqual(readFileSync(cachedFile(sample)), bytes); assert.deepEqual(readFileSync(sample.output), bytes);
  } finally { sample.close(); }
});

test('HTTP errors, HTML, wrong hashes and oversized bodies never become a license or leak network errors', async () => {
  for (const response of [
    () => new Response('server failure', { status: 503 }),
    () => new Response('<html>upstream error</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('wrong license bytes'),
    () => new Response(bytes, { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1)),
    () => { throw new Error('https://user:network-secret@invalid.test/?token=do-not-disclose'); },
  ]) {
    const sample = fixture(); let calls = 0;
    try {
      await assert.rejects(() => install({ ...sample, fetcher: async () => { calls++; return response(); } }), error => {
        assert.equal(error.code, 'NODE_LICENSE_UNAVAILABLE');
        assert.equal(error.message, '无法获取经校验的 Node 许可文件，请检查网络后重试。');
        assert.doesNotMatch(error.message, /network-secret|do-not-disclose|https?:/); return true;
      });
      assert.equal(calls, 3); assert.equal(existsSync(sample.output), false); assert.equal(existsSync(cachedFile(sample)), false); noTemporaryFiles(sample);
    } finally { sample.close(); }
  }
  const sample = fixture();
  try {
    const html = Buffer.from('<!DOCTYPE html><html>Not a license</html>');
    const htmlInstaller = createLicenseInstaller({ version: NODE_LICENSE_VERSION, sha256: sha256(html) });
    await assert.rejects(() => htmlInstaller({ ...sample, sourceBytes: html }), { code: 'NODE_LICENSE_INVALID' });
  } finally { sample.close(); }
});

test('attempt and total deadlines cover an uncooperative fetch and a stalled response body', async () => {
  for (const mode of ['fetch', 'body']) {
    const sample = fixture(); const signals = []; let calls = 0;
    const start = performance.now();
    try {
      await assert.rejects(() => install({ ...sample, attemptTimeoutMs: 12, totalTimeoutMs: 30, fetcher: async (_url, options) => {
        calls++; signals.push(options.signal);
        if (mode === 'fetch') return new Promise(() => {});
        return { ok: true, arrayBuffer: () => new Promise(() => {}) };
      } }), { code: 'NODE_LICENSE_UNAVAILABLE' });
      assert.ok(calls >= 1 && calls <= 3); assert.ok(signals.every(signal => signal.aborted));
      assert.ok(performance.now() - start < 500, 'a stalled source cannot outlive the bounded total budget');
      assert.equal(existsSync(sample.output), false); noTemporaryFiles(sample);
    } finally { sample.close(); }
  }
});

test('callers cannot accidentally exceed the 15-second/45-second/three-attempt network ceiling', async () => {
  const sample = fixture(); let calls = 0;
  try {
    for (const options of [{ attemptTimeoutMs: 15001 }, { totalTimeoutMs: 45001 }, { attempts: 4 }, { attempts: 0 }]) {
      await assert.rejects(() => install({ ...sample, ...options, fetcher: async () => { calls++; return new Response(bytes); } }), { code: 'NODE_LICENSE_INVALID' });
    }
    assert.equal(calls, 0);
  } finally { sample.close(); }
});

test('cache/output symlinks and symlink ancestors cannot overwrite any external target', { skip: process.platform === 'win32' }, async () => {
  for (const kind of ['cache-file', 'output-file', 'cache-directory', 'cache-ancestor', 'output-directory']) {
    const sample = fixture(); let calls = 0;
    try {
      const outside = join(sample.root, 'outside'); mkdirSync(outside);
      const victim = join(outside, 'private.txt'); writeFileSync(victim, 'must remain untouched');
      if (kind === 'cache-file') { mkdirSync(sample.cacheDir); symlinkSync(victim, cachedFile(sample)); }
      if (kind === 'output-file') { mkdirSync(join(sample.root, 'runtime')); symlinkSync(victim, sample.output); }
      if (kind === 'cache-directory') symlinkSync(outside, sample.cacheDir);
      if (kind === 'cache-ancestor') { symlinkSync(outside, join(sample.root, 'link')); sample.cacheDir = join(sample.root, 'link', 'cache'); }
      if (kind === 'output-directory') symlinkSync(outside, join(sample.root, 'runtime'));
      await assert.rejects(() => install({ ...sample, sourceBytes: bytes, fetcher: async () => { calls++; return new Response(bytes); } }), { code: 'NODE_LICENSE_UNSAFE_PATH' });
      assert.equal(readFileSync(victim, 'utf8'), 'must remain untouched'); assert.deepEqual(readdirSync(outside), ['private.txt']); assert.equal(calls, 0);
    } finally { sample.close(); }
  }
});
