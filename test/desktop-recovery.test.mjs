import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecoveryPoint, listRecoveryPoints, validateRecoveryPoint, applyRecoveryPoint } from '../desktop/recovery.mjs';
import * as recovery from '../desktop/recovery.mjs';
import { acquireDataOwner } from '../src/core/data-owner.mjs';
import { ServiceManager } from '../desktop/service.mjs';
import { terminateTree } from '../server/platform.mjs';
import { transformSecrets } from '../server/secrets.mjs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('Recovery verifies hashes before writing and never restores browser grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-')), data = join(root, 'data'), state = join(root, 'state');
  const paths = { data, state, secret: join(state, 'secret-key.bin') };
  await mkdir(data); await mkdir(state);
  try {
    await writeFile(join(data, 'config.json'), JSON.stringify({ markdown: { dir: 'test' } }));
    await writeFile(join(data, 'context.db'), 'test-database'); await writeFile(paths.secret, 'encrypted-os-key');
    await writeFile(join(data, 'context.db-wal'), 'fixture committed WAL');
    await writeFile(join(data, 'extension-pairings.json'), 'current-browser-grants');
    const point = await createRecoveryPoint(paths, { appVersion: '1.0.0', sealConfig: value => value });
    assert.equal(await readFile(join(state, 'recovery', point.id, 'context.db-wal'), 'utf8'), 'fixture committed WAL');
    assert.equal((await listRecoveryPoints(paths))[0].id, point.id);
    await validateRecoveryPoint(paths, point.id);
    await writeFile(join(data, 'context.db'), 'new-database'); await applyRecoveryPoint(paths, point.id);
    assert.equal(await readFile(join(data, 'context.db'), 'utf8'), 'test-database');
    assert.equal(await readFile(join(data, 'context.db-wal'), 'utf8'), 'fixture committed WAL');
    assert.equal(await readFile(join(data, 'extension-pairings.json'), 'utf8'), 'current-browser-grants');
    await writeFile(join(state, 'recovery', point.id, 'context.db'), 'corrupted');
    await assert.rejects(() => applyRecoveryPoint(paths, point.id), /校验/);
    assert.equal(await readFile(join(data, 'context.db'), 'utf8'), 'test-database');
    await assert.rejects(() => validateRecoveryPoint(paths, '../escape'), /无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('A damaged OS key is retained and exposes a recoverable blocked state, never a replacement key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-key-'));
  const paths = { data: root, state: root, secret: join(root, 'secret-key.bin') };
  try {
    await writeFile(paths.secret, 'damaged-key');
    assert.equal(typeof recovery.loadProtectedSecret, 'function', 'startup must preserve a recovery UI when credentials fail');
    const result = recovery.loadProtectedSecret(paths, { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('fixture decryption failure'); }, encryptString: () => { throw new Error('must not replace'); } });
    assert.match(result.blockedReason, /密钥|恢复/); assert.equal(result.key, undefined);
    assert.equal(await readFile(paths.secret, 'utf8'), 'damaged-key');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('A missing key with encrypted or malformed config is never silently regenerated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-missing-key-'));
  const paths = { data: root, state: root, secret: join(root, 'secret-key.bin') };
  const protector = { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('must not create'); } };
  try {
    for (const contents of ['{"translate":{"apiKey":"contextflow:sealed:v1:fixture"}}', '{broken config']) {
      await writeFile(join(root, 'config.json'), contents);
      const result = recovery.loadProtectedSecret(paths, protector); assert.ok(result.blockedReason); assert.equal(result.key, undefined);
      await assert.rejects(() => readFile(paths.secret), { code: 'ENOENT' }); assert.equal(await readFile(join(root, 'config.json'), 'utf8'), contents);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Offline restore rolls back damaged original bytes and missing files if the new core fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-offline-')), data = join(root, 'data'), state = join(root, 'state');
  const paths = { data, state, secret: join(state, 'secret-key.bin') };
  await mkdir(data); await mkdir(state);
  try {
    await writeFile(join(data, 'config.json'), JSON.stringify({ port: 7317 })); await writeFile(join(data, 'context.db'), 'good fixture database'); await writeFile(paths.secret, 'protected fixture key');
    const point = await createRecoveryPoint(paths, { appVersion: 'fixture', sealConfig: value => value });
    await writeFile(join(data, 'config.json'), '{broken config'); await writeFile(join(data, 'context.db'), 'broken database');
    await rm(paths.secret); await writeFile(join(data, 'context.db-wal'), 'original damaged WAL');
    assert.equal(typeof recovery.restoreStoppedDesktop, 'function', 'restore must not depend on an already healthy core');
    const service = { state: 'error', child: null, secretKey: undefined, port: 7317, blockedReason: 'original blocked state',
      health: async () => null, start: async function () { this.state = 'error'; }, stop: async function () { this.child = null; this.state = 'stopped'; } };
    await assert.rejects(() => recovery.restoreStoppedDesktop(paths, point.id, { service, appVersion: 'fixture',
      safeStorage: { decryptString: () => Buffer.alloc(32, 1).toString('base64') }, decodeConfig: value => value, acquireOwner: acquireDataOwner }), /保护副本|回滚/);
    assert.equal(await readFile(join(data, 'config.json'), 'utf8'), '{broken config');
    assert.equal(await readFile(join(data, 'context.db'), 'utf8'), 'broken database');
    assert.equal(await readFile(join(data, 'context.db-wal'), 'utf8'), 'original damaged WAL');
    await assert.rejects(() => readFile(paths.secret), { code: 'ENOENT' });
    assert.equal(service.blockedReason, 'original blocked state');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Offline restore rejects a live external data owner or an unreadable backup key before mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-owned-')), data = join(root, 'data'), state = join(root, 'state');
  const paths = { data, state, secret: join(state, 'secret-key.bin') }; await mkdir(data); await mkdir(state);
  let owner;
  try {
    await writeFile(join(data, 'config.json'), '{}'); await writeFile(join(data, 'context.db'), 'fixture database'); await writeFile(paths.secret, 'protected fixture key');
    const point = await createRecoveryPoint(paths, { appVersion: 'fixture', sealConfig: value => value });
    await writeFile(join(data, 'config.json'), '{broken');
    const service = { state: 'error', child: null, health: async () => null, start: async () => { throw new Error('must not start'); }, stop: async () => {} };
    const options = { service, appVersion: 'fixture', safeStorage: { decryptString: () => Buffer.alloc(32, 1).toString('base64') }, decodeConfig: value => value, acquireOwner: acquireDataOwner };
    owner = acquireDataOwner(data);
    await assert.rejects(() => recovery.restoreStoppedDesktop(paths, point.id, options), { code: 'DATA_DIRECTORY_BUSY' });
    owner.release(); owner = null;
    await assert.rejects(() => recovery.restoreStoppedDesktop(paths, point.id, { ...options, safeStorage: { decryptString: () => { throw new Error('fixture key locked'); } } }), /fixture key locked/);
    assert.equal(await readFile(join(data, 'config.json'), 'utf8'), '{broken');
    assert.equal(await readFile(paths.secret, 'utf8'), 'protected fixture key');
  } finally { owner?.release(); await rm(root, { recursive: true, force: true }); }
});

test('A real isolated failed core can restore a verified point and restart without replacing browser grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-real-core-')), data = join(root, 'data'), state = join(root, 'state');
  const paths = { data, state, secret: join(state, 'secret-key.bin'), logs: join(state, 'logs') };
  await mkdir(data); await mkdir(state);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const key = randomBytes(32).toString('base64'); let service;
  try {
    await writeFile(join(data, 'config.json'), JSON.stringify({ port })); await writeFile(paths.secret, 'protected fixture key');
    service = new ServiceManager({ paths, runtime: process.execPath, core: fileURLToPath(new URL('..', import.meta.url)), secretKey: key, terminateTree });
    await service.start(); assert.equal(service.state, 'running');
    const response = await fetch(`http://127.0.0.1:${port}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ContextFlow': '1', Authorization: `Bearer ${service.token}` },
      body: JSON.stringify([{ id: 'offline-recovery-kept-record', action: 'comment', urlKey: 'https://fixture.invalid/recovery', url: 'https://fixture.invalid/recovery', title: 'Isolated recovery', text: 'fixture quote', value: 'record must survive recovery', createdAt: Date.now() }]) });
    assert.equal(response.status, 200);
    await service.stop();
    const point = await createRecoveryPoint(paths, { appVersion: 'fixture', sealConfig: value => transformSecrets(transformSecrets(value, 'decode', key), 'encode', key) });
    await writeFile(join(data, 'config.json'), '{broken config'); await writeFile(join(data, 'context.db'), 'broken database'); await writeFile(paths.secret, 'damaged key');
    await writeFile(join(data, 'extension-pairings.json'), '{}');
    service.secretKey = undefined; service.blockedReason = 'fixture startup blocked'; service.update('error', service.blockedReason);
    const result = await recovery.restoreStoppedDesktop(paths, point.id, { service, appVersion: 'fixture', acquireOwner: acquireDataOwner,
      safeStorage: { decryptString: bytes => { assert.equal(bytes.toString(), 'protected fixture key'); return key; } }, decodeConfig: (value, encodedKey) => transformSecrets(value, 'decode', encodedKey) });
    assert.equal(result.ok, true); assert.equal(service.state, 'running');
    const health = await service.request('/health'); assert.equal(health.status, 200); assert.equal(health.body.stats.total, 1, 'recovery must retain committed SQLite records, not only restart an empty schema');
    assert.equal(await readFile(join(data, 'extension-pairings.json'), 'utf8'), '{}');
    const protection = join(state, 'recovery-protection', result.protectedBy);
    assert.equal(await readFile(join(protection, 'config.json'), 'utf8'), '{broken config');
    assert.equal(await readFile(join(protection, 'secret-key.bin'), 'utf8'), 'damaged key');
  } finally { await service?.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
