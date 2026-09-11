// 公开userscript直接写 Obsidian / Markdown 文件夹。
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB; global.IDBKeyRange = IDBKeyRange;
// 浏览器原生支持 FileSystemHandle 的 structured clone；测试替身保留方法模拟这一特殊类型。
global.structuredClone = (value) => value;
global.location = { origin: 'https://example.com' };

class FileHandle {
  constructor(name, dir) { this.name = name; this.kind = 'file'; this.dir = dir; }
  async getFile() {
    const data = this.dir.files.get(this.name) || '';
    return { text: async () => typeof data === 'string' ? data : data.text() };
  }
  async createWritable() { let next = ''; return { write: async (s) => { next = s; }, close: async () => this.dir.files.set(this.name, next) }; }
}
class DirHandle {
  constructor(name = 'Vault') { this.name = name; this.kind = 'directory'; this.files = new Map(); this.dirs = new Map(); this.permission = 'granted'; }
  async queryPermission() { return this.permission; }
  async requestPermission() { return this.permission; }
  async getFileHandle(name, o = {}) { if (!this.files.has(name) && !o.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); return new FileHandle(name, this); }
  async getDirectoryHandle(name, o = {}) {
    if (!this.dirs.has(name) && !o.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    if (!this.dirs.has(name)) this.dirs.set(name, new DirHandle(name));
    return this.dirs.get(name);
  }
  async *values() { for (const name of this.files.keys()) yield new FileHandle(name, this); }
}

const store = await import('../src/core/offline-store.js');
const sync = await import('../src/public/file-sync.js');
const { assetToken } = await import('../src/core/assets.js');
let pass = 0; const t = async (n, f) => { try { await f(); console.log(`  ok   ${n}`); pass++; } catch (e) { console.log(`  FAIL ${n}\n       ${e.stack}`); process.exitCode = 1; } };
const dir = new DirHandle();
const event = (id, action, value, o = {}) => ({ id, urlKey: 'fs:u', url: 'https://x', title: 'Article', action,
  text: action === 'note' ? null : 'source', value, anchor: { start: o.start || 1 }, createdAt: o.at || 100, ...o });
console.log('公开userscript文件同步\n');

await t('用户选择目录并持久化 handle', async () => {
  global.showDirectoryPicker = async () => dir;
  const s = await sync.chooseFileTarget('obsidian'); assert.equal(s.name, 'Vault'); assert.equal(s.permission, 'granted');
});

await t('首次同步建立一文一档与日期索引', async () => {
  await store.putOfflineArticle({ urlKey: 'fs:u', title: 'Article', url: 'https://x', text: 'body'.repeat(400) });
  await store.saveOfflineEvents([event('sm:1', 'summary', '速览'), event('tr:1', 'translate', '译文'), event('note:1', 'note', '我的总结')], { queue: false });
  const r = await sync.syncToFileTarget('fs:u'); assert.equal(r.inserted, 3);
  assert.ok(dir.files.has('Article.md')); const md = dir.files.get('Article.md');
  assert.match(md, /cf:art fs:u/); assert.match(md, /<!-- cf:source -->\n> 来源：<https:\/\/x\/>/);
  assert.equal((md.match(/<!-- cf:source -->/g) || []).length, 1);
  assert.ok(md.indexOf('## 速览') < md.indexOf('## 翻译')); assert.match(md, /## 总结/);
  assert.match(dir.files.get('1970-01-01.md'), /\[\[Article\]\].*cf:idx fs:u/);
});

await t('重复同步不重复', async () => {
  const before = dir.files.get('Article.md'); const r = await sync.syncToFileTarget('fs:u');
  assert.equal(r.inserted, 0); assert.equal(r.updated, 0); assert.equal(dir.files.get('Article.md'), before);
});


await t('旧文件补齐原文链接且重复同步不追加', async () => {
  dir.files.set('Article.md', dir.files.get('Article.md').replace(/\n<!-- cf:source -->\n> 来源：<[^>]+>/, ''));
  const first = await sync.syncToFileTarget('fs:u');
  assert.equal(first.sourceChanged, true);
  assert.ok(first.files.includes('Article.md'));
  const once = dir.files.get('Article.md');
  assert.equal((once.match(/<!-- cf:source -->/g) || []).length, 1);
  const second = await sync.syncToFileTarget('fs:u');
  assert.equal(second.sourceChanged, false);
  assert.equal(dir.files.get('Article.md'), once);
});

await t('图文记录把图片复制到附件目录并改写相对路径', async () => {
  const png = new Blob([Buffer.from('89504e470d0a1a0a01020304', 'hex')], { type: 'image/png' });
  const asset = await store.saveOfflineAsset(png, { name: 'figure.png' });
  const key = 'fs:asset';
  await store.putOfflineArticle({ urlKey: key, title: 'With Image', url: 'https://x/image', text: 'body' });
  await store.saveOfflineEvents([event('note:image', 'note', `图前\n\n${assetToken(asset.id, '原文图')}\n\n图后`, {
    urlKey: key, title: 'With Image', url: 'https://x/image',
  })], { queue: false });
  const r = await sync.syncToFileTarget(key);
  assert.equal(r.inserted, 1);
  const md = dir.files.get('With Image.md');
  assert.match(md, new RegExp(`!\\[原文图\\]\\(assets/contextflow/${asset.id}\\.png\\)`));
  const assetDir = dir.dirs.get('assets')?.dirs.get('contextflow');
  assert.ok(assetDir?.files.get(`${asset.id}.png`) instanceof Blob);
  assert.equal(await assetDir.files.get(`${asset.id}.png`).text(), await png.text());
});

await t('内容修改原地更新', async () => {
  await store.saveOfflineEvents([event('note:1', 'note', '新总结', { updatedAt: Date.now(), mutationId: 'm2' })], { queue: false });
  const r = await sync.syncToFileTarget('fs:u'); assert.ok(r.updated >= 1);
  const md = dir.files.get('Article.md'); assert.match(md, /新总结/); assert.ok(!md.includes('我的总结'));
});

await t('标题变化仍写同一个文件', async () => {
  await store.putOfflineArticle({ urlKey: 'fs:u', title: 'Renamed', url: 'https://x', text: 'body'.repeat(400) });
  await sync.syncToFileTarget('fs:u'); assert.ok(dir.files.has('Article.md')); assert.ok(!dir.files.has('Renamed.md'));
});

await t('显式 tombstone 删除块且第二次不重复处理', async () => {
  const old = (await store.listOfflineEvents('fs:u', { includeDeleted: true })).find((x) => x.id === 'tr:1');
  await store.saveOfflineEvents([store.mutationStamp(old, { deleted: true, at: Date.now() + 10 })], { queue: false });
  const first = await sync.syncToFileTarget('fs:u');
  assert.equal(first.deleted, 1); assert.ok(!dir.files.get('Article.md').includes('cf:tr:1'));
  const second = await sync.syncToFileTarget('fs:u');
  assert.equal(second.deleted, 0); assert.equal(second.conflicts, 0);
});

await t('用户改过的删除块保留正文、移除 marker，冲突只报一次', async () => {
  await store.saveOfflineEvents([event('ex:manual', 'explain', '原回答', { extra: { question: 'Q' }, updatedAt: Date.now(), mutationId: 'x1' })], { queue: false });
  await sync.syncToFileTarget('fs:u');
  dir.files.set('Article.md', dir.files.get('Article.md').replace('原回答', '用户手改回答'));
  const old = (await store.listOfflineEvents('fs:u', { includeDeleted: true })).find((x) => x.id === 'ex:manual');
  await store.saveOfflineEvents([store.mutationStamp(old, { deleted: true, at: Date.now() + 20 })], { queue: false });
  const first = await sync.syncToFileTarget('fs:u');
  assert.equal(first.conflicts, 1); assert.equal(first.preserved, 1);
  assert.match(dir.files.get('Article.md'), /用户手改回答/); assert.ok(!dir.files.get('Article.md').includes('cf:ex:manual'));
  const second = await sync.syncToFileTarget('fs:u'); assert.equal(second.conflicts, 0);
});

console.log(`\n${pass} 项通过`);
