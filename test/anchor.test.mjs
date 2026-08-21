// 三层降级判定逻辑的无浏览器单测。
// anchor.js 里只有 buildTextIndex 依赖真实 DOM；resolveAnchor / serializeRange
// 只吃 index 结构，因此用合成 index + 极简 document stub 即可完整覆盖。
import assert from 'node:assert/strict';
import { resolveAnchor, serializeRange, CTX_LEN } from '../src/core/anchor.js';

// --- 最小 DOM stub ---
globalThis.document = {
  createRange() {
    return {
      s: null, e: null,
      setStart(n, o) { this.s = [n, o]; },
      setEnd(n, o) { this.e = [n, o]; },
      get collapsed() { return !this.s || !this.e || this.s[1] === this.e[1]; },
    };
  },
};

/** 合成一个「整段文本映射到单个节点」的索引 */
function fakeIndex(text) {
  // nodeType: 3 —— 合成数据也要像真的文本节点，否则会掩盖只在真实 DOM 下
  // 才走到的分支（boundaryOffset 的元素边界处理就是这么被漏测的）
  const node = { nodeType: 3, nodeValue: text };
  const seg = { node, nodeStart: 0, textStart: 0, len: text.length };
  return { text, segs: [seg], nodeSegs: new Map([[node, [seg]]]) };
}

const at = (res) => [res.range.s[1], res.range.e[1]];

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('resolveAnchor 三层降级');

t('第1层：偏移命中 → position', () => {
  const idx = fakeIndex('alpha beta gamma delta');
  const res = resolveAnchor({ exact: 'beta', prefix: 'alpha ', suffix: ' gamma', start: 6, end: 10 }, idx);
  assert.equal(res.tier, 'position');
  assert.deepEqual(at(res), [6, 10]);
});

t('第2层：偏移失效但引文唯一 → quote', () => {
  const idx = fakeIndex('XXXXXXXXXX alpha beta gamma delta');
  // start/end 仍是旧值 6/10，此处已不是 beta
  const res = resolveAnchor({ exact: 'beta', prefix: 'alpha ', suffix: ' gamma', start: 6, end: 10 }, idx);
  assert.equal(res.tier, 'quote');
  assert.deepEqual(at(res), [17, 21]);
});

t('第2层：重复文本靠上下文打分选中第二处', () => {
  const dup = 'the model achieves sota';
  const text = `${dup} and then unrelated filler here and ${dup} tail`;
  const second = text.lastIndexOf(dup);
  const idx = fakeIndex(text);
  const res = resolveAnchor({
    exact: dup,
    prefix: text.slice(second - CTX_LEN, second),
    suffix: text.slice(second + dup.length, second + dup.length + CTX_LEN),
    start: 9999, end: 9999 + dup.length,           // 位置信息完全错误
  }, idx);
  assert.equal(res.tier, 'quote');
  assert.deepEqual(at(res), [second, second + dup.length], '应命中第二处而非第一处');
});

t('第2层：过期的超大 start 不应压过上下文分（回归）', () => {
  // 曾因 bestScore 初值为 -1 且位置惩罚未归一化，导致所有候选得分为负而整层空转
  const dup = 'repeated phrase';
  const text = `${dup} middle filler text ${dup} end`;
  const second = text.lastIndexOf(dup);
  const idx = fakeIndex(text);
  const res = resolveAnchor({
    exact: dup,
    prefix: text.slice(0, second),
    suffix: ' end',
    start: 10 ** 9, end: 10 ** 9 + dup.length,   // 完全离谱的过期偏移
  }, idx);
  assert.equal(res.tier, 'quote', '不应掉到 fuzzy');
  assert.deepEqual(at(res), [second, second + dup.length]);
});

t('第2层：无上下文的重复文本按位置就近选中', () => {
  const dup = 'same words';
  const text = `${dup} xxxxxxxxxxxxxxxxxxxx ${dup}`;
  const second = text.lastIndexOf(dup);
  const idx = fakeIndex(text);
  const res = resolveAnchor({ exact: dup, prefix: '', suffix: '', start: second, end: second + dup.length }, idx);
  assert.equal(res.tier, 'position');   // 偏移本身有效，第 1 层就命中
  const res2 = resolveAnchor({ exact: dup, prefix: '', suffix: '', start: second + 3, end: second + 3 + dup.length }, idx);
  assert.equal(res2.tier, 'quote');
  assert.deepEqual(at(res2), [second, second + dup.length], '应选离原偏移更近的第二处');
});

t('第3层：大小写与空白改动 → fuzzy', () => {
  const idx = fakeIndex('Multi   HEAD    Attention allows the model to attend.');
  const res = resolveAnchor({
    exact: 'Multi head attention allows', prefix: '', suffix: '', start: 0, end: 27,
  }, idx);
  assert.equal(res.tier, 'fuzzy');
});

t('标点改动 → 失锚返回 null（优雅降级，不抛异常）', () => {
  const idx = fakeIndex('Multi-head attention allows the model to attend.');
  const res = resolveAnchor({
    exact: 'Multi head attention allows', prefix: '', suffix: '', start: 0, end: 27,
  }, idx);
  assert.equal(res, null);
});

t('空 exact 不崩', () => {
  assert.equal(resolveAnchor({ exact: '', start: 0, end: 0 }, fakeIndex('abc')), null);
});

console.log('\nserializeRange');

t('序列化产出 exact/prefix/suffix 且可往返', () => {
  const text = 'zero one two three four five six seven eight nine ten eleven twelve';
  const idx = fakeIndex(text);
  const node = idx.segs[0].node;
  const start = text.indexOf('three'), end = start + 'three'.length;
  const a = serializeRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: end }, idx);
  assert.equal(a.exact, 'three');
  assert.equal(a.start, start);
  assert.ok(text.endsWith(a.suffix) || a.suffix.length === CTX_LEN);
  const res = resolveAnchor(a, idx);
  assert.equal(res.tier, 'position');
  assert.deepEqual(at(res), [start, end]);
});

t('倒置/空选区返回 null', () => {
  const idx = fakeIndex('abcdef');
  const node = idx.segs[0].node;
  assert.equal(serializeRange({ startContainer: node, startOffset: 4, endContainer: node, endOffset: 2 }, idx), null);
  assert.equal(serializeRange({ startContainer: node, startOffset: 3, endContainer: node, endOffset: 3 }, idx), null);
});

console.log(`\n${pass} 项通过`);
