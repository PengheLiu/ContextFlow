import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairExtension, extensionAuthorized } from '../server/extension-pairing.mjs';

test('per-row revocation isolates legacy and native grants; CLI all-ID revocation is preserved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'contextflow-revoke-scope-'));
  const previous = process.env.CONTEXTFLOW_DIR; process.env.CONTEXTFLOW_DIR = directory;
  const id = 'aemncphfnlpbhlddifhohpgegejjejfm', origin = `chrome-extension://${id}`, instanceId = 'isolated-native-instance-0001';
  try {
    let legacy = pairExtension(id, { directory });
    const native = pairExtension(id, { directory, instanceId });
    assert.equal(extensionAuthorized(origin, legacy), true); assert.equal(extensionAuthorized(origin, native, instanceId), true);
    pairExtension(id, { directory, revoke: true, legacyOnly: true });
    assert.equal(extensionAuthorized(origin, legacy), false); assert.equal(extensionAuthorized(origin, native, instanceId), true);
    legacy = pairExtension(id, { directory });
    pairExtension(id, { directory, revoke: true, instanceId });
    assert.equal(extensionAuthorized(origin, native, instanceId), false); assert.equal(extensionAuthorized(origin, legacy), true);
    const second = pairExtension(id, { directory, instanceId });
    pairExtension(id, { directory, revoke: true });
    assert.equal(extensionAuthorized(origin, legacy), false); assert.equal(extensionAuthorized(origin, second, instanceId), false);
    assert.throws(() => pairExtension(id, { directory, legacyOnly: true }), /仅可/);
    assert.throws(() => pairExtension(id, { directory, revoke: true, legacyOnly: true, instanceId }), /仅可/);
    assert.equal(readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8').includes('legacyOnly: !instanceId'), true);
  } finally {
    if (previous === undefined) delete process.env.CONTEXTFLOW_DIR; else process.env.CONTEXTFLOW_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
