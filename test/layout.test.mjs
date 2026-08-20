// 笔记版式：分组顺序与文档命名。
// 两个后端共用这一层，错了会让思源与 Obsidian 产出不同的笔记。
import assert from 'node:assert/strict';
import { CATEGORIES, CAT_KEYS, CAT_OF, groupByCategory, docName } from '../server/layout.mjs';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const ev = (id, action, start, extra = {}) =>
  ({ id, action, anchor: start === null ? null : { start }, ...extra });
const ids = (arr) => arr.map((e) => e.id).join(',');

console.log('笔记版式\n');

// ---- 分类 ----

t('顺序与面板 tab 一致：翻译 解释 批注 总结', () =>
  assert.deepEqual(CAT_KEYS, ['translate', 'explain', 'comments', 'note']));

t('高亮与评论同归「批注」', () => {
  assert.equal(CAT_OF.get('highlight'), 'comments');
  assert.equal(CAT_OF.get('comment'), 'comments');
});

t('每个 action 只归一个分类', () => {
  const seen = new Set();
  for (const c of CATEGORIES) for (const a of c.actions) {
    assert.ok(!seen.has(a), `${a} 归了多个分类`);
    seen.add(a);
  }
});

t('四个分类都有标签', () =>
  CATEGORIES.forEach((c) => assert.ok(c.label, `${c.key} 缺 label`)));

// ---- 分组 ----

t('空分类不出现在结果里（不写空标题）', () => {
  const g = groupByCategory([ev('a', 'note', null)]);
  assert.deepEqual([...g.keys()], ['note']);
});

t('分组键序遵循 CATEGORIES，与入参顺序无关', () => {
  const g = groupByCategory([ev('n', 'note', null), ev('t', 'translate', 5), ev('h', 'highlight', 1)]);
  assert.deepEqual([...g.keys()], ['translate', 'comments', 'note']);
});

t('翻译 / 解释按原文位置排，不按传入顺序', () => {
  const g = groupByCategory([ev('后', 'translate', 90), ev('前', 'translate', 10)]);
  assert.equal(ids(g.get('translate')), '前,后');
});

t('高亮按位置排，其评论紧随其后', () => {
  const g = groupByCategory([
    ev('h2', 'highlight', 90), ev('c2', 'comment', 90, { parentId: 'h2' }),
    ev('h1', 'highlight', 10), ev('c1', 'comment', 10, { parentId: 'h1' }),
  ]);
  assert.equal(ids(g.get('comments')), 'h1,c1,h2,c2');
});

t('一条高亮的多条评论都跟在它后面', () => {
  const g = groupByCategory([
    ev('h', 'highlight', 1),
    ev('cA', 'comment', 1, { parentId: 'h' }),
    ev('cB', 'comment', 1, { parentId: 'h' }),
  ]);
  assert.equal(ids(g.get('comments')), 'h,cA,cB');
});

// 父高亮在更早批次已同步，本批只有评论 —— 不能因为找不到宿主就丢掉
t('孤儿评论仍被保留', () => {
  const g = groupByCategory([ev('c', 'comment', 5, { parentId: '早已同步的高亮' })]);
  assert.equal(ids(g.get('comments')), 'c');
});

t('缺 anchor 不抛，当作位置 0', () => {
  const g = groupByCategory([ev('有', 'translate', 5), ev('无', 'translate', null)]);
  assert.equal(ids(g.get('translate')), '无,有');
});

t('不改动入参数组', () => {
  const arr = [ev('b', 'translate', 9), ev('a', 'translate', 1)];
  groupByCategory(arr);
  assert.equal(ids(arr), 'b,a');
});

// ---- 命名 ----

t('普通标题原样保留', () =>
  assert.equal(docName('Attention Is All You Need', 'k'), 'Attention Is All You Need'));

t('路径与保留字符被清掉', () => {
  const n = docName('A/B\\C:D*E?F"G<H>I|J', 'k');
  assert.ok(!/[/\\:*?"<>|]/.test(n), `残留非法字符：${n}`);
});

t('连字符和空格保留（论文标题里很常见）', () =>
  assert.equal(docName('multi-turn RL agent', 'k'), 'multi-turn RL agent'));

t('控制字符被清掉', () => {
  const n = docName(`A\u0000B\u001fC`, 'k');
  assert.ok(!/[\u0000-\u001f]/.test(n), `残留控制字符：${JSON.stringify(n)}`);
});

t('首尾的点被去掉（避免隐藏文件 / . .. 语义）', () => {
  assert.ok(!docName('...hidden', 'k').startsWith('.'));
  assert.ok(!docName('trailing...', 'k').endsWith('.'));
  assert.ok(!['.', '..'].includes(docName('..', 'k')));
});

t('超长标题被截断，且按字符数而非字节数', () => {
  const n = docName('中'.repeat(200), 'k');
  assert.ok([...n].length <= 60, `${[...n].length} 字`);
  assert.ok(Buffer.byteLength(n, 'utf8') < 240, `${Buffer.byteLength(n)} 字节`);
});

t('截断不留下尾部空格', () =>
  assert.equal(docName(`${'a'.repeat(59)} bbb`, 'k'), 'a'.repeat(59)));

t('空标题回落到 urlKey 派生名，不返回空串', () => {
  for (const bad of ['', '   ', null, undefined, '///', '...']) {
    const n = docName(bad, 'arxiv:2608.09867');
    assert.ok(n && n.trim() === n && n.length > 0, `${JSON.stringify(bad)} → ${JSON.stringify(n)}`);
  }
});

t('不同 urlKey 的空标题不会撞名', () =>
  assert.notEqual(docName('', 'arxiv:1'), docName('', 'arxiv:2')));

t('同名不同文章追加短哈希后缀', () => {
  const n = docName('Threat Model', 'arxiv:2', (x) => x === 'Threat Model');
  assert.notEqual(n, 'Threat Model');
  assert.match(n, /^Threat Model \([0-9a-f]{8}\)$/);
});

t('后缀由 urlKey 决定，同一篇重算恒定（换机重建不会改名）', () =>
  assert.equal(
    docName('T', 'arxiv:9', () => true),
    docName('T', 'arxiv:9', () => true)));

t('名字没被占用时不加后缀', () =>
  assert.equal(docName('Unique', 'k', () => false), 'Unique'));

console.log(`\n${pass} 项通过`);
