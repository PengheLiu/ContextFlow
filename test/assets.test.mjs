import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Node']) global[key] = dom.window[key];

const { assetToken, assetIds, inlineAssetTokens, splitAssetDocument, joinAssetDocument, replaceAssetTokens } =
  await import('../src/core/assets.js');
const { RichComposer } = await import('../src/skill/rich-composer.js');

const ID = 'a'.repeat(64);
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
};

console.log('图文附件与编辑器\n');

await t('内部图片引用可拆分、原样拼回并按后端改写', () => {
  const raw = `前文\n\n${assetToken(ID, '图 1')}\n\n后文`;
  const blocks = splitAssetDocument(raw);
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image', 'text']);
  assert.equal(joinAssetDocument(blocks), raw);
  assert.deepEqual(assetIds(raw), [ID]);
  assert.equal(replaceAssetTokens(raw, () => 'assets/contextflow/a.png'),
    '前文\n\n![图 1](assets/contextflow/a.png)\n\n后文');
});

await t('复制或单文件下载时临时内嵌图片，不把 Base64 写回事件', async () => {
  const id = 'b'.repeat(64), source = `前文\n\n${assetToken(id, '图')}\n\n后文`;
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const exported = await inlineAssetTokens(source, async (wanted) => wanted === id
    ? { blob, mime: 'image/png' } : null);
  assert.match(exported, /!\[图\]\(data:image\/png;base64,AQID\)/);
  assert.equal(source.includes('base64'), false, '原始事件字符串不应被改写');
  assert.equal(assetIds(exported).length, 0);
});

await t('在光标位置贴图会拆开文字，并显示可删除的原子图片块', async () => {
  const values = [], commits = [];
  const editor = new RichComposer(document.getElementById('mount'), {
    value: '前后', onAsset: async () => ({ id: ID, alt: '截图' }),
    resolveAsset: async () => 'data:image/png;base64,AA==',
    onInput: (value) => values.push(value), onCommit: (value) => commits.push(value),
  });
  await editor.insertImage(0, 1, 1, { name: '截图.png', type: 'image/png' });
  assert.equal(editor.value(), `前\n\n${assetToken(ID, '截图')}\n\n后`);
  assert.equal(editor.mount.querySelectorAll('.rc-figure').length, 1);
  assert.equal(values.at(-1), editor.value());
  assert.equal(commits.at(-1), editor.value());
  const afterFirst = editor.mount.querySelectorAll('.rc-text')[1];
  afterFirst.value = `${afterFirst.value}继续`;
  await editor.insertImage(2, afterFirst.value.length, afterFirst.value.length,
    { name: '第二张.png', type: 'image/png' });
  assert.equal(editor.mount.querySelectorAll('.rc-figure').length, 2);
  assert.equal(document.activeElement, editor.mount.querySelectorAll('.rc-text')[2],
    '连续贴图后应把焦点放到新图片后面的文字块');
  editor.mount.querySelector('.rc-remove').click();
  assert.equal(assetIds(editor.value()).length, 1);
});

await t('侧栏与原位反向镜像不能覆盖尚未保存或失败的图片块，完成或移除后恢复更新', async () => {
  let release;
  const mount = document.createElement('div'); document.body.append(mount);
  const editor = new RichComposer(mount, { value: '图片原位文字', onAsset: () => new Promise(resolve => { release = resolve; }), onCommit: () => {} });
  const pending = editor.insertImage(0, 6, 6, { name: 'pending.png' });
  const block = editor.blocks.find(row => row.pending);
  editor.setValue('另一端的镜像不能抹掉图片');
  assert.ok(editor.blocks.includes(block)); assert.equal(block.pending, true);
  assert.match(editor.hint.textContent, /已保留原位草稿/);
  release({ id: ID }); await pending;
  assert.ok(editor.value().includes('图片原位文字')); assert.ok(editor.value().includes(assetToken(ID, 'pending')));
  editor.setValue('图片已落盘后的正常更新'); assert.equal(editor.value(), '图片已落盘后的正常更新');

  editor.o.onAsset = () => Promise.reject(new Error('asset quota'));
  await editor.insertImage(0, 0, 0, { name: 'failed.png' });
  const failed = editor.blocks.find(row => row.error);
  editor.setValue('另一端的镜像不能抹掉失败占位');
  assert.ok(editor.blocks.includes(failed)); assert.match(editor.hint.textContent, /图片保存失败.*保留原位草稿/);
  editor.list.querySelector('.rc-remove').click();
  editor.setValue('用户处理完成后的正常更新'); assert.equal(editor.value(), '用户处理完成后的正常更新');
  mount.remove();
});

console.log(`\n${pass} 项通过`);
