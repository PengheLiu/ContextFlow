import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
globalThis.indexedDB = indexedDB; globalThis.IDBKeyRange = IDBKeyRange;
const store = await import('../src/core/offline-store.js');
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
const event = (id, overrides = {}) => ({ id, urlKey: 'https://legacy-upgrade.test/Case', url: 'https://legacy-upgrade.test/Case',
  action: 'comment', value: 'durable newer', createdAt: 1, updatedAt: 30, mutationId: 'new', ...overrides });
async function operations() {
  const db = await store.openOfflineStore(), tx = db.transaction('operations', 'readonly'), done = complete(tx);
  const rows = await request(tx.objectStore('operations').getAll()); await done; return rows;
}
beforeEach(async () => {
  const db = await store.openOfflineStore(), tx = db.transaction(['events', 'operations', 'meta'], 'readwrite'), done = complete(tx);
  for (const name of ['events', 'operations', 'meta']) tx.objectStore(name).clear(); await done;
});

test('first canonical mirror import preserves newer durable data, delete-wins ties and the outbox', async () => {
  const live = event('mirror-newer'), dead = event('mirror-dead', { deletedAt: 30, mutationId: 'a' });
  await store.saveOfflineEvents([live, dead]); const before = await operations();
  const stale = { ...live, value: 'old localStorage', updatedAt: 20, mutationId: 'old' };
  assert.equal(await store.migrateArticleMirror(live.urlKey, [stale, { ...dead, deletedAt: null, mutationId: 'z' }]), true);
  const rows = await store.listOfflineEvents(live.urlKey, { includeDeleted: true });
  assert.equal(rows.find(row => row.id === live.id).value, live.value);
  assert.equal(rows.find(row => row.id === dead.id).deletedAt, 30);
  assert.deepEqual(await operations(), before);
  assert.equal(await store.migrateArticleMirror(live.urlKey, [stale]), false);
});

test('a conflicting global ID aborts a mirror import and its marker so the original archive stays recoverable', async () => {
  const original = event('protected'); await store.saveOfflineEvents([original]);
  const other = event('new-before-conflict'), conflict = event(original.id, { urlKey: 'https://other.test/article', url: 'https://other.test/article', updatedAt: 50 });
  await assert.rejects(() => store.migrateArticleMirror(conflict.urlKey, [other, conflict]), /标识|冲突/);
  assert.deepEqual((await store.readingLibrarySnapshot()).events, [original]);
  assert.equal(await store.migrateArticleMirror(conflict.urlKey, []), true, 'a failed migration must not commit its completion marker');
});

test('legacy outbox import never replaces a newer durable mutation or an immutable sending lease', async () => {
  const current = event('outbox-newer'); await store.saveOfflineEvents([current]);
  const claimed = await store.claimOperations('upgrade-in-flight'); const before = await operations();
  const stale = { ...current, urlKey: current.urlKey.toLowerCase(), value: 'stale outbox', updatedAt: 20, mutationId: '' };
  assert.equal(await store.migrateLegacyOutbox([stale]), true);
  assert.equal((await store.listOfflineEvents(current.urlKey))[0].value, current.value);
  assert.deepEqual(await operations(), before);
  await store.acknowledgeOperations(claimed);
});

test('an unsent legacy event already imported through its mirror still gets one canonical queued operation', async () => {
  const row = event('mirror-then-outbox', { urlKey: 'https://legacy-upgrade.test/case', updatedAt: undefined, mutationId: undefined });
  await store.migrateArticleMirror('https://legacy-upgrade.test/Case', [row]);
  await store.migrateLegacyOutbox([row, { ...row, value: 'older duplicate', createdAt: 0 }]);
  const rows = (await store.readingLibrarySnapshot()).events;
  assert.equal(rows.length, 1); assert.equal(rows[0].urlKey, 'https://legacy-upgrade.test/Case');
  assert.equal(rows[0].value, row.value);
  const queued = await operations(); assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.urlKey, rows[0].urlKey); assert.equal(queued[0].payload.value, row.value);
});

test('a newer legacy mutation queues independently of an existing sending lease and survives its acknowledgment', async () => {
  const current = event('legacy-newer-than-lease'); await store.saveOfflineEvents([current]);
  const [claimed] = await store.claimOperations('older-tab');
  const newer = { ...current, value: 'newer unsent legacy edit', updatedAt: 50, mutationId: 'newer' };
  await store.migrateLegacyOutbox([newer]);
  const rows = await operations(), original = rows.find(row => row.opId === claimed.opId);
  assert.deepEqual(original, { ...claimed, coalesceKey: `sending:${claimed.opId}` });
  assert.equal(rows.find(row => row.opId !== claimed.opId).payload.value, newer.value);
  await store.acknowledgeOperations([claimed]);
  assert.equal((await operations()).length, 1);
  assert.equal((await store.listOfflineEvents(current.urlKey))[0].value, newer.value);
});

test('a conflicting legacy outbox rolls back all new events, operations and its completion marker', async () => {
  const original = event('outbox-protected'); await store.saveOfflineEvents([original]);
  const before = await operations();
  await assert.rejects(() => store.migrateLegacyOutbox([event('before-outbox-conflict'), event(original.id, {
    urlKey: 'https://other.test/article', url: 'https://other.test/article', updatedAt: 50,
  })]), /标识|冲突/);
  assert.deepEqual((await store.readingLibrarySnapshot()).events, [original]);
  assert.deepEqual(await operations(), before);
  assert.equal(await store.migrateLegacyOutbox([]), true);
});
