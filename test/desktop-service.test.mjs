import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ServiceManager } from '../desktop/service.mjs';
import { terminateTree } from '../server/platform.mjs';

test('Desktop owns a real isolated core, authenticates all requests and shuts down gracefully', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-desktop-service-'));
  const data = join(root, 'data'); mkdirSync(data);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ port, token: 'legacy-core-test', requireToken: false }));
  const service = new ServiceManager({ paths: { data, logs: join(root, 'logs') }, runtime: process.execPath,
    core: fileURLToPath(new URL('..', import.meta.url)), secretKey: randomBytes(32).toString('base64'), terminateTree,
    environment: { ...process.env, NODE_PATH: '/nonexistent-contextflow-global-modules', NODE_OPTIONS: '--require /nonexistent-contextflow-hook.cjs' } });
  try {
    await service.start(); assert.equal(service.state, 'running', service.message);
    assert.ok(service.child.spawnargs.includes('--no-global-search-paths'), 'bundled core must not resolve user-global modules');
    assert.equal((await service.request('/health')).body.desktopManaged, true);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-ContextFlow': '1' } });
    assert.equal(unauthorized.status, 401, 'desktop mode enforces authentication even for legacy requireToken=false');
    const configured = await service.request('/config', { method: 'POST', body: JSON.stringify({ translate: { apiKey: 'only-test-private-key', model: 'mock', baseUrl: 'https://example.test' } }) });
    assert.equal(configured.status, 200); assert.equal(configured.body.translate.apiKeySet, true);
    assert.equal(JSON.stringify(configured.body).includes('only-test-private-key'), false);
    assert.equal(readFileSync(join(data, 'config.json'), 'utf8').includes('only-test-private-key'), false);
    assert.equal((await service.request('/health')).body.syncStatus.verified, false, 'default path is not a successful write');
    const notes = join(root, 'test-notes');
    await service.request('/config', { method: 'POST', body: JSON.stringify({ sync: { backend: 'markdown' }, markdown: { dir: notes, folder: '/' } }) });
    const source = { id: 'desktop-sync-proof', action: 'comment', urlKey: 'desktop-sync-proof', url: 'https://example.test/reading',
      title: 'Desktop verification', text: 'A source quote', value: 'A private test note', createdAt: Date.now() };
    const saved = await fetch(`http://127.0.0.1:${port}/events`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ContextFlow': '1', Authorization: `Bearer ${service.token}` }, body: JSON.stringify([source]) });
    assert.equal(saved.status, 200);
    const synced = await service.request('/sync', { method: 'POST', body: JSON.stringify({ urlKey: source.urlKey }) });
    assert.equal(synced.status, 200, JSON.stringify(synced.body)); assert.ok(synced.body.articles > 0);
    const verified = (await service.request('/health')).body.syncStatus;
    assert.equal(verified.verified, true); assert.ok(verified.lastSyncAt > 0);
    await service.request('/config', { method: 'POST', body: JSON.stringify({ markdown: { dir: join(root, 'another-notes') } }) });
    assert.equal((await service.request('/health')).body.syncStatus.verified, false, 'changing destination invalidates the receipt');
    await assert.rejects(() => service.request('https://example.test/config'));
    const pid = service.child.pid; await service.stop(); assert.equal(service.child, null); assert.equal(service.state, 'stopped');
    assert.throws(() => process.kill(pid, 0));
    await service.start(); assert.equal(service.state, 'running');
    assert.equal((await service.request('/config')).body.translate.apiKeySet, true, 'encrypted settings survive restart');
  } finally { await service.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test('An occupied service port is never killed or started over', async () => {
  let spawned = false;
  const service = new ServiceManager({ paths: { data: '/nonexistent-contextflow-test' }, runtime: '/unused', core: '/unused',
    fetcher: async () => ({ ok: false }), spawnProcess: () => { spawned = true; } });
  await service.start(); assert.equal(service.state, 'external'); assert.equal(spawned, false);
});
test('Startup, failure and stop transitions invalidate desktop readiness without waiting for polling', () => {
  const service = new ServiceManager({ paths: { data: '/nonexistent-contextflow-test' }, runtime: '/unused', core: '/unused' });
  const states = []; service.on('changed', () => states.push(service.snapshot().state));
  for (const state of ['starting', 'running', 'error', 'stopped']) service.update(state);
  assert.deepEqual(states, ['starting', 'running', 'error', 'stopped']);
});

test('Quitting during startup prevents a delayed probe from spawning an orphan service', async () => {
  let release, spawned = false;
  const service = new ServiceManager({ paths: { data: '/nonexistent-contextflow-test' }, runtime: '/unused', core: '/unused',
    fetcher: () => new Promise(resolve => { release = resolve; }), spawnProcess: () => { spawned = true; } });
  const starting = service.start();
  await service.stop(); release({ ok: false }); await starting;
  assert.equal(service.state, 'stopped'); assert.equal(spawned, false);
});
