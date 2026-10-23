import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Each Chrome installation gets its own credential; revocation is scoped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cf-native-pair-'));
  const previous = process.env.CONTEXTFLOW_DIR; process.env.CONTEXTFLOW_DIR = directory;
  try {
    const { pairExtension, extensionAuthorized, pairedOrigin, listPairings } = await import('../server/extension-pairing.mjs');
    const id = 'a'.repeat(32), origin = `chrome-extension://${id}`, one = 'profile-instance-one', two = 'profile-instance-two';
    const legacy = pairExtension(id), first = pairExtension(id, { instanceId: one, label: 'Chrome 1' });
    const second = pairExtension(id, { instanceId: two, label: 'Chrome 2' });
    assert.equal(extensionAuthorized(origin, first, one), true); assert.equal(extensionAuthorized(origin, second, two), true);
    assert.equal(extensionAuthorized(origin, legacy), true); assert.equal(extensionAuthorized(origin, first, two), false);
    assert.equal(extensionAuthorized(origin, first), false); assert.equal(pairedOrigin(origin), true);
    pairExtension(id, { instanceId: one, revoke: true });
    assert.equal(extensionAuthorized(origin, first, one), false); assert.equal(extensionAuthorized(origin, second, two), true);
    assert.equal(listPairings().length, 2); assert.ok(!readFileSync(join(directory, 'extension-pairings.json'), 'utf8').includes(second));
    pairExtension(id, { revoke: true }); assert.equal(extensionAuthorized(origin, second, two), false);
  } finally { if (previous === undefined) delete process.env.CONTEXTFLOW_DIR; else process.env.CONTEXTFLOW_DIR = previous; rmSync(directory, { recursive: true, force: true }); }
});
