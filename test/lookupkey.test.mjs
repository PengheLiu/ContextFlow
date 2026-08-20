// 查询记录去重键。
// 去重是"稳定 id + upsert"实现的，因此这个键的口径直接决定列表里会不会重复。
import assert from 'node:assert/strict';
import { lookupKey, lookupId, hashKey } from '../src/core/lookupkey.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const K = 'arxiv:2608.09867';
const same = (a, b) => lookupId(K, a) === lookupId(K, b);
const tr = (text, target) => ({ action: 'translate', text, extra: { target } });
const ex = (text, question) => ({ action: 'explain', text, extra: { question } });

console.log('查询记录去重键');

t('同段同语言翻译 → 合并', () =>
  assert.ok(same(tr('encrypted block', '简体中文'), tr('encrypted block', '简体中文'))));

t('空白差异不影响合并', () =>
  assert.ok(same(tr('encrypted  block ', '简体中文'), tr('encrypted block', '简体中文'))));

t('同段翻成不同语言 → 分开', () =>
  assert.ok(!same(tr('encrypted block', '简体中文'), tr('encrypted block', 'English'))));

t('同段同问题 → 合并', () =>
  assert.ok(same(ex('abc', '为什么？'), ex('abc', ' 为什么？ '))));

t('同段不同问题 → 分开（这是有价值的两条记录，不该合并）', () =>
  assert.ok(!same(ex('abc', '为什么？'), ex('abc', '怎么做？'))));

t('留空问题与有问题 → 分开', () =>
  assert.ok(!same(ex('abc', ''), ex('abc', '为什么？'))));

t('翻译与解释同段 → 分开', () =>
  assert.ok(!same(tr('abc', 'x'), ex('abc', 'x'))));

t('不同文章的同一段 → 分开（记录归属于文章）', () =>
  assert.notEqual(lookupId('arxiv:1', tr('abc', 'zh')), lookupId('arxiv:2', tr('abc', 'zh'))));

t('id 带可读前缀，便于排查', () => {
  assert.match(lookupId(K, tr('abc', 'zh')), /^tr:[0-9a-f]{16}$/);
  assert.match(lookupId(K, ex('abc', 'q')), /^ex:[0-9a-f]{16}$/);
});

t('hash 稳定且无明显碰撞（2000 条不同输入）', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(hashKey(`sample text number ${i}`));
  assert.equal(seen.size, 2000, '出现碰撞');
  assert.equal(hashKey('abc'), hashKey('abc'), '同输入不稳定');
});

t('缺 extra 不崩', () => {
  assert.doesNotThrow(() => lookupId(K, { action: 'translate', text: 'abc' }));
  assert.doesNotThrow(() => lookupId(K, { action: 'explain', text: 'abc' }));
});


t('首尾标点差异 → 合并（线上实际案例）', () =>
  assert.ok(same(tr('Threat model', 'zh'), tr('Threat model.', 'zh'))));

t('中文首尾标点差异 → 合并', () =>
  assert.ok(same(tr('加密块', 'en'), tr('「加密块」。', 'en'))));

t('内部标点差异 → 分开（不是同一段）', () =>
  assert.ok(!same(tr('multi-turn', 'zh'), tr('multi turn', 'zh'))));

t('大小写差异 → 分开（避免展示时原文被覆盖）', () =>
  assert.ok(!same(tr('IT', 'zh'), tr('it', 'zh'))));

t('整段皆标点不归一成空串（否则会互相合并）', () =>
  assert.ok(!same(tr('...', 'zh'), tr('???', 'zh'))));


// 分隔符回归：曾用空格分隔，一度退化成无分隔，字段边界可被伪造。
// 注意 same() 收的是事件对象（内部自己算 id），别传已算好的键。
t('相邻字段边界不得碰撞 —— explain', () =>
  assert.ok(!same(ex('AB', 'C'), ex('A', 'BC'))));

t('相邻字段边界不得碰撞 —— translate', () =>
  assert.ok(!same(tr('AB', 'C'), tr('A', 'BC'))));

t('正文含分隔符也无法伪造字段边界', () =>
  assert.ok(!same(ex('A\u001fBC', ''), ex('A', 'BC'))));

console.log(`\n${pass} 项通过`);
