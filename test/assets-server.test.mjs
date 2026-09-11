import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cf-assets-'));
const OUT = mkdtempSync(join(tmpdir(), 'cf-assets-out-'));
process.env.CONTEXTFLOW_DIR = HOME;
const db = await import('../server/db.mjs');
const assets = await import('../server/assets.mjs');
const { syncAll } = await import('../server/mdfile.mjs');
const { assetToken } = await import('../src/core/assets.js');

// 附件库只需要验证文件类型签名；完整图片解码由浏览器预览负责。
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('contextflow-image')]);
const ID = createHash('sha256').update(PNG).digest('hex');
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
};

console.log('本地附件库\n');

await t('Base64 只用于上传，服务端按 SHA-256 去重落盘', () => {
  const meta = assets.saveAsset({ id: ID, mime: 'image/png', name: 'shot.png', data: PNG.toString('base64') });
  assert.equal(meta.id, ID); assert.equal(db.getAsset(ID).size, PNG.length);
  assert.deepEqual(readFileSync(assets.getAsset(ID).path), PNG);
  assets.saveAsset({ id: ID, mime: 'image/png', name: 'again.png', data: PNG.toString('base64') });
  assert.ok(existsSync(assets.getAsset(ID).path));
});

await t('伪装成 PNG 的任意内容会被拒绝', () => {
  const bad = Buffer.from('not an image'), id = createHash('sha256').update(bad).digest('hex');
  assert.throws(() => assets.saveAsset({ id, mime: 'image/png', data: bad.toString('base64') }), /格式/);
});

await t('Markdown/Obsidian 同步会复制附件并改写成相对路径', async () => {
  const at = Date.now();
  db.upsertEvents([{ id: 'note:asset', urlKey: 'asset-article', url: 'https://example.com/a', title: '图片笔记',
    action: 'note', text: null, value: `上文\n\n${assetToken(ID, '原文图')}\n\n下文`, color: null,
    anchor: null, parentId: null, createdAt: at }]);
  await syncAll({ backend: 'markdown', root: OUT, folder: '' }, { urlKey: 'asset-article' });
  const md = readFileSync(join(OUT, '图片笔记.md'), 'utf8');
  assert.match(md, new RegExp(`!\\[原文图\\]\\(assets/contextflow/${ID}\\.png\\)`));
  assert.deepEqual(readFileSync(join(OUT, 'assets', 'contextflow', `${ID}.png`)), PNG);
});

rmSync(HOME, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
console.log(`\n${pass} 项通过`);
