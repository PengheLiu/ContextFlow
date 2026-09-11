// IndexedDB 离线队列：合并、tombstone、lease 与远端冲突。
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

const store = await import('../src/core/offline-store.js');
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
};
const ev = (id, o = {}) => ({ id, urlKey: 'u', url: 'https://x', title: 'T', action: 'highlight',
  text: id, value: null, color: 'yellow', anchor: null, parentId: null, createdAt: 10, ...o });

console.log('IndexedDB 离线事实库\n');

await t('upsert 原子保存事件与 queued operation', async () => {
  const e = store.mutationStamp(ev('a'), { at: 100, mutationId: 'm1' });
  await store.saveOfflineEvents([e]);
  assert.deepEqual((await store.listOfflineEvents('u')).map((x) => x.id), ['a']);
  assert.equal(await store.operationCount('u'), 1);
});

await t('同 id 连续 upsert 合并成最新一个操作', async () => {
  await store.saveOfflineEvents([store.mutationStamp(ev('a', { value: 'new' }), { at: 101, mutationId: 'm2' })]);
  assert.equal(await store.operationCount('u'), 1);
  assert.equal((await store.listOfflineEvents('u'))[0].value, 'new');
});

await t('delete 覆盖 queued upsert，live 列表立即隐藏但 tombstone 保留', async () => {
  const [dead] = await store.tombstoneOfflineEvents([ev('a', { value: 'new', updatedAt: 101, mutationId: 'm2' })]);
  assert.ok(dead.deletedAt);
  assert.equal(await store.operationCount('u'), 1);
  assert.equal((await store.listOfflineEvents('u')).length, 0);
  assert.equal((await store.listOfflineEvents('u', { includeDeleted: true }))[0].id, 'a');
});

await t('claim 后新编辑不会被旧 lease 的 ack 一起删除', async () => {
  await store.saveOfflineEvents([store.mutationStamp(ev('b'), { at: 200, mutationId: 'b1' })]);
  const claimed = await store.claimOperations('tab-one', 10);
  assert.ok(claimed.length >= 1);
  await store.saveOfflineEvents([store.mutationStamp(ev('b', { value: 'later' }), { at: 201, mutationId: 'b2' })]);
  await store.acknowledgeOperations(claimed);
  assert.equal(await store.operationCount('u'), 1, '新编辑应保留一个 queued operation');
});

await t('失败 release 只释放 token 匹配的 claim，可重新领取', async () => {
  const c = await store.claimOperations('tab-two', 10);
  assert.equal(c.length, 1);
  await store.releaseOperations(c, new Error('offline'));
  const again = await store.claimOperations('tab-three', 10);
  assert.equal(again.length, 1);
  assert.notEqual(again[0].lease.token, c[0].lease.token);
  await store.acknowledgeOperations(again);
  assert.equal(await store.operationCount('u'), 0);
});

await t('相同时间 delete wins，过期远端 upsert 不能复活', async () => {
  const dead = store.mutationStamp(ev('c'), { deleted: true, at: 300, mutationId: 'z' });
  await store.saveOfflineEvents([dead], { queue: false });
  await store.applyRemoteEvents([store.mutationStamp(ev('c', { value: 'stale' }), { at: 300, mutationId: 'zz' })]);
  const row = (await store.listOfflineEvents('u', { includeDeleted: true })).find((x) => x.id === 'c');
  assert.ok(row.deletedAt, '同时间 live 不得覆盖 tombstone');
});

await t('明确更晚的新建可以覆盖旧 tombstone', async () => {
  await store.applyRemoteEvents([store.mutationStamp(ev('c', { value: 'reborn' }), { at: 301, mutationId: 'n' })]);
  const row = (await store.listOfflineEvents('u')).find((x) => x.id === 'c');
  assert.equal(row.value, 'reborn');
});

await t('文章正文写入、去重、截断并可读回', async () => {
  const first = await store.putOfflineArticle({ urlKey: 'article-u', title: 'A', url: 'https://x/a', text: '正文' });
  assert.equal(first.changed, true);
  assert.equal((await store.putOfflineArticle({ urlKey: 'article-u', title: 'A', url: 'https://x/a', text: '正文' })).changed, false);
  const row = await store.getOfflineArticle('article-u');
  assert.equal(row.text, '正文');
  assert.ok(row.lastUsedAt);
  const huge = await store.putOfflineArticle({ urlKey: 'huge-u', text: 'x'.repeat(400_100) });
  assert.equal(huge.truncated, true);
  const hugeRow = await store.getOfflineArticle('huge-u');
  assert.equal(hugeRow.text.length, 400_000);
  assert.equal(hugeRow.truncated, true);
  assert.equal(hugeRow.originalChars, 400_100);
  assert.equal(hugeRow.storedChars, 400_000);
});

await t('图片 Blob 独立保存、内容去重并记录待上传状态', async () => {
  const first = await store.saveOfflineAsset(new Blob(['same-image'], { type: 'image/png' }), { name: 'a.png' });
  const second = await store.saveOfflineAsset(new Blob(['same-image'], { type: 'image/png' }), { name: 'b.png' });
  assert.equal(first.id, second.id);
  assert.equal((await store.getOfflineAsset(first.id)).blob.size, 10);
  assert.ok((await store.listPendingAssets()).some((x) => x.id === first.id));
  await store.markOfflineAssetUploaded(first.id, 123);
  assert.equal((await store.getOfflineAsset(first.id)).uploadedAt, 123);
  assert.ok(!(await store.listPendingAssets()).some((x) => x.id === first.id));
});

await t('旧 localStorage outbox 迁移后保留 queued 操作并幂等', async () => {
  const old = [ev('outbox-old', { urlKey: 'outbox-u', createdAt: 40 })];
  assert.equal(await store.migrateLegacyOutbox(old), true);
  assert.equal(await store.migrateLegacyOutbox(old), false);
  assert.equal(await store.operationCount('outbox-u'), 1);
});

await t('旧 localStorage 镜像迁移幂等且不产生待发送操作', async () => {
  const old = [ev('legacy', { urlKey: 'legacy-u', createdAt: 50 })];
  assert.equal(await store.migrateArticleMirror('legacy-u', old), true);
  assert.equal(await store.migrateArticleMirror('legacy-u', old), false);
  assert.equal((await store.listOfflineEvents('legacy-u')).length, 1);
  assert.equal(await store.operationCount('legacy-u'), 0);
});

console.log(`\n${pass} 项通过`);
