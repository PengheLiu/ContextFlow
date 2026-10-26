import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { articleIdentity } from '../src/core/urlkey.js';
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const store = await import('../src/core/offline-store.js');
const event = (id, url, overrides = {}) => ({ id, urlKey: url.toLowerCase().replace(/#.*$/, ''), url, action: 'highlight', text: id,
  createdAt: 1, updatedAt: 10, mutationId: 'm-' + id, parentId: null, ...overrides });
async function seed(events, operations = []) {
  const db = await store.openOfflineStore(), tx = db.transaction(['events', 'operations'], 'readwrite');
  for (const row of events) tx.objectStore('events').put(row);
  for (const row of operations) tx.objectStore('operations').put(row);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
}
const operation = row => ({ opId: 'op-' + row.id, kind: row.deletedAt ? 'delete' : 'upsert', coalesceKey: 'event:' + row.id,
  urlKey: row.urlKey, entityId: row.id, payload: row, createdAt: 1, state: 'queued', lease: null, leaseUntil: 0 });

test('URL repair atomically splits a legacy bucket, preserves IDs/parents/tombstones and queued payloads', async () => {
  const upper = event('upper', 'https://identity.test/Foo.md'), lower = event('lower', 'https://identity.test/foo.md');
  const comment = event('comment', upper.url, { action: 'comment', parentId: upper.id, value: 'kept' });
  const dead = event('deleted', upper.url, { deletedAt: 11 });
  await seed([upper, lower, comment, dead], [upper, lower, comment, dead].map(operation));
  const result = await store.migrateArticleIdentity(articleIdentity(upper.url));
  assert.equal(result.moved, 3); assert.equal(result.ambiguous, 0);
  const rows = await store.listOfflineEvents(articleIdentity(upper.url).key, { includeDeleted: true });
  assert.deepEqual(rows.map(row => row.id).sort(), ['comment', 'deleted', 'upper']);
  assert.equal(rows.find(row => row.id === comment.id).parentId, upper.id);
  assert.equal(rows.find(row => row.id === dead.id).deletedAt, 11);
  assert.equal(rows.find(row => row.id === upper.id).mutationId, upper.mutationId);
  const claimed = await store.claimOperations('identity-check');
  for (const row of claimed.filter(row => row.entityId !== lower.id)) {
    assert.equal(row.urlKey, 'https://identity.test/Foo.md'); assert.equal(row.payload.urlKey, row.urlKey);
  }
  await store.acknowledgeOperations(claimed);
});

test('an active sending lease stays byte-for-byte intact; compatible read works until retry', async () => {
  const row = event('leased', 'https://lease.test/Case'); await seed([row], [operation(row)]);
  const claimed = await store.claimOperations('old-client'); const original = structuredClone(claimed.find(op => op.entityId === row.id));
  const result = await store.migrateArticleIdentity(articleIdentity(row.url));
  assert.equal(result.deferred, 1); assert.equal(result.moved, 0);
  const visible = await store.listOfflineEvents(articleIdentity(row.url).key);
  assert.equal(visible[0].id, row.id); assert.equal(visible[0].urlKey, articleIdentity(row.url).key);
  const db = await store.openOfflineStore(), tx = db.transaction('operations', 'readonly'), request = tx.objectStore('operations').get(original.opId);
  const stored = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  assert.deepEqual(stored, original);
  await store.acknowledgeOperations(claimed);
  assert.equal((await store.migrateArticleIdentity(articleIdentity(row.url))).moved, 1);
});

test('missing URLs stay in the legacy bucket and are reported instead of guessed', async () => {
  const row = event('ambiguous', 'https://ambiguous.test/Foo'); row.url = ''; await seed([row]);
  const result = await store.migrateArticleIdentity(articleIdentity('https://ambiguous.test/Foo'));
  assert.equal(result.ambiguous, 1); assert.equal(result.moved, 0);
  assert.equal((await store.listOfflineEvents('https://ambiguous.test/Foo')).length, 0);
  assert.equal((await store.listOfflineEvents(row.urlKey))[0].id, row.id);
});

test('editing a compatible legacy event does not leave duplicate physical IDs', async () => {
  const row = event('edit-legacy', 'https://edited.test/Case'); await seed([row]);
  await store.saveOfflineEvents([{ ...row, urlKey: articleIdentity(row.url).key, value: 'new', updatedAt: 20, mutationId: 'new' }]);
  const snapshot = await store.readingLibrarySnapshot();
  assert.equal(snapshot.events.filter(event => event.id === row.id).length, 1);
  assert.equal(snapshot.events.find(event => event.id === row.id).urlKey, articleIdentity(row.url).key);
});

test('failed IndexedDB repair rolls back moved rows and queued payloads together', async () => {
  const one=event('rollback-one','https://rollback-store.test/Case'),two=event('rollback-two',one.url);
  await seed([one,two],[one,two].map(operation));
  const db=await store.openOfflineStore(),probe=db.transaction('events','readonly').objectStore('events');
  const prototype=Object.getPrototypeOf(probe),original=prototype.put;
  prototype.put=function(value,...args){if(this.name==='events'&&value.id===two.id&&value.urlKey===articleIdentity(two.url).key)throw new Error('fixture IDB repair failure');return original.call(this,value,...args)};
  try { await assert.rejects(()=>store.migrateArticleIdentity(articleIdentity(one.url)),/fixture IDB repair failure/); }
  finally {prototype.put=original;}
  const snapshot=await store.readingLibrarySnapshot();
  for(const row of snapshot.events.filter(row=>[one.id,two.id].includes(row.id)))assert.equal(row.urlKey,one.urlKey);
  const queued=await store.claimOperations('rollback-inspect');
  for(const op of queued.filter(row=>[one.id,two.id].includes(row.entityId)))assert.equal(op.payload.urlKey,one.urlKey);
  await store.acknowledgeOperations(queued);
});

test('a stale sync mirror preserves newer durable edits and leaves every outbox row unchanged', async () => {
  const row = event('mirror-concurrent', 'https://mirror.test/article', { value: 'newer local edit', updatedAt: 30, mutationId: 'new' });
  await store.saveOfflineEvents([row]);
  const leased = await store.claimOperations('mirror-in-flight');
  const db = await store.openOfflineStore();
  const queued = async () => {
    const request = db.transaction('operations', 'readonly').objectStore('operations').getAll();
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  };
  const before = await queued();
  const stale = { ...row, value: 'older remote snapshot', updatedAt: 20, mutationId: 'old' };
  await store.applyRemoteEvents([stale]);
  await store.saveOfflineEvents([stale], { queue: false });
  assert.equal((await store.listOfflineEvents(row.urlKey))[0].value, row.value);
  assert.deepEqual(await queued(), before, 'mirror writes must not replace or acknowledge queued payloads');
  await store.saveOfflineEvents([{ ...stale, mutationId: undefined }], { queue: false });
  assert.equal((await store.listOfflineEvents(row.urlKey))[0].value, row.value, 'an old client mirror must not fabricate a new edit clock');
  assert.deepEqual(await queued(), before);
  await store.acknowledgeOperations(leased);
});

test('sync mirrors use the same clock, delete-wins and mutation tie breakers as remote reconciliation', async () => {
  const cases = [
    { id: 'mirror-delete', old: { deletedAt: 40, mutationId: 'a' }, incoming: { deletedAt: null, mutationId: 'z' }, winner: 'durable' },
    { id: 'mirror-new-delete', old: { deletedAt: null, mutationId: 'z' }, incoming: { deletedAt: 40, mutationId: 'a' }, winner: 'incoming' },
    { id: 'mirror-tie-newer', old: { mutationId: 'z' }, incoming: { mutationId: 'a' }, winner: 'durable' },
    { id: 'mirror-tie-equal', old: { mutationId: 'same' }, incoming: { mutationId: 'same' }, winner: 'durable' },
    { id: 'mirror-tie-advance', old: { mutationId: 'a' }, incoming: { mutationId: 'z' }, winner: 'incoming' },
  ];
  for (const fixture of cases) {
    const row = event(fixture.id, 'https://mirror.test/' + fixture.id, { updatedAt: 40, value: 'durable', ...fixture.old });
    await seed([row], [operation(row)]);
    await store.saveOfflineEvents([{ ...row, value: 'incoming', ...fixture.incoming }], { queue: false });
    const stored = (await store.listOfflineEvents(row.urlKey, { includeDeleted: true }))[0];
    assert.equal(stored.value, fixture.winner, fixture.id);
    assert.equal(stored.deletedAt || null, fixture.winner === 'durable' ? row.deletedAt || null : fixture.incoming.deletedAt || null, fixture.id);
  }
});

test('a stale mirror can repair a legacy compound key without overwriting its newer mutation', async () => {
  const row = event('mirror-legacy', 'https://mirror-legacy.test/Case', { value: 'durable', updatedAt: 50, mutationId: 'latest' });
  await seed([row], [operation(row)]);
  await store.saveOfflineEvents([{ ...row, value: 'stale', updatedAt: 40, mutationId: 'old' }], { queue: false });
  const rows = (await store.readingLibrarySnapshot()).events.filter(event => event.id === row.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urlKey, articleIdentity(row.url).key);
  assert.equal(rows[0].value, 'durable');
});
