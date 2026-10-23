import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecoveryPoint, listRecoveryPoints, validateRecoveryPoint, applyRecoveryPoint } from '../desktop/recovery.mjs';

test('Recovery verifies hashes before writing and never restores browser grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cf-recovery-')), data = join(root, 'data'), state = join(root, 'state');
  const paths = { data, state, secret: join(state, 'secret-key.bin') };
  await mkdir(data); await mkdir(state);
  try {
    await writeFile(join(data, 'config.json'), JSON.stringify({ markdown: { dir: 'test' } }));
    await writeFile(join(data, 'context.db'), 'test-database'); await writeFile(paths.secret, 'encrypted-os-key');
    await writeFile(join(data, 'extension-pairings.json'), 'current-browser-grants');
    const point = await createRecoveryPoint(paths, { appVersion: '1.0.0', sealConfig: value => value });
    assert.equal((await listRecoveryPoints(paths))[0].id, point.id);
    await validateRecoveryPoint(paths, point.id);
    await writeFile(join(data, 'context.db'), 'new-database'); await applyRecoveryPoint(paths, point.id);
    assert.equal(await readFile(join(data, 'context.db'), 'utf8'), 'test-database');
    assert.equal(await readFile(join(data, 'extension-pairings.json'), 'utf8'), 'current-browser-grants');
    await writeFile(join(state, 'recovery', point.id, 'context.db'), 'corrupted');
    await assert.rejects(() => applyRecoveryPoint(paths, point.id), /校验/);
    assert.equal(await readFile(join(data, 'context.db'), 'utf8'), 'test-database');
    await assert.rejects(() => validateRecoveryPoint(paths, '../escape'), /无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
