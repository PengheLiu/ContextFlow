import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataOwner } from '../src/core/data-owner.mjs';
import { migrateLegacyDir } from '../server/config.mjs';

test('A live external owner cannot be stolen; normal release permits a recovery owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-owner-live-'));
  try {
    const first = acquireDataOwner(root), before = readFileSync(join(root, '.contextflow-owner.lock'));
    assert.throws(() => acquireDataOwner(root, { kind: 'recovery' }), { code: 'DATA_DIRECTORY_BUSY' });
    assert.deepEqual(readFileSync(join(root, '.contextflow-owner.lock')), before);
    first.release(); const second = acquireDataOwner(root, { kind: 'recovery' }); second.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('The ownership directory is created only after an established legacy data directory is migrated', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-owner-migration-'));
  try {
    const legacy = join(root, 'legacy'), current = join(root, 'current'); mkdirSync(legacy);
    writeFileSync(join(legacy, 'context.db'), 'legacy user database');
    migrateLegacyDir(current, legacy);
    const owner = acquireDataOwner(current);
    assert.equal(readFileSync(join(current, 'context.db'), 'utf8'), 'legacy user database'); owner.release();
    const source = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
    assert.ok(source.indexOf('migrateLegacyDir();') < source.indexOf('const dataOwner = acquireDataOwner'));
    assert.ok(source.indexOf('const dataOwner = acquireDataOwner') < source.indexOf('let cfg = loadConfig()'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Dead owner cleanup is serialized and an old release cannot delete its replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-owner-stale-'));
  try {
    const first = acquireDataOwner(root), second = acquireDataOwner(root, { kind: 'recovery', isAlive: () => false });
    const before = readFileSync(join(root, '.contextflow-owner.lock')); first.release();
    assert.deepEqual(readFileSync(join(root, '.contextflow-owner.lock')), before); second.release();
    writeFileSync(join(root, '.contextflow-owner.lock'), 'unknown damaged owner');
    assert.throws(() => acquireDataOwner(root), { code: 'DATA_DIRECTORY_BUSY' });
    assert.equal(readFileSync(join(root, '.contextflow-owner.lock'), 'utf8'), 'unknown damaged owner');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
