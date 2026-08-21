// Highlighter 的通道分组。
//
// 重点不是"能不能画出来"（那要真浏览器），而是**注册进 CSS.highlights 的
// 通道名与顺序** —— 顺序决定重叠时谁的背景在上，是纯推理定下的约束，
// 不锁进测试就会在后续重构里被无声改掉。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Highlighter, COLORS, MARKS } from '../src/core/highlight.js';

const dom = new JSDOM('<!doctype html><p>abc</p>');
global.document = dom.window.document;

// 最小替身：Map 天然保留插入顺序，正好用来观察注册顺序
class FakeHighlight { constructor(...ranges) { this.ranges = ranges; } }
global.Highlight = FakeHighlight;
global.CSS = { highlights: new Map() };

const range = (s) => ({ toString: () => s, _s: s });
const chans = () => [...CSS.highlights.keys()];
const fresh = () => { CSS.highlights.clear(); return new Highlighter(); };

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('Highlighter 通道分组\n');

t('颜色进同名通道', () => {
  const h = fresh();
  h.set('a', range('x'), 'green');
  h.render();
  assert.deepEqual(chans(), ['contextflow-green']);
});

t('标记进 mark- 前缀通道，不与颜色重名', () => {
  const h = fresh();
  h.set('a', range('x'), 'explain');
  h.set('b', range('y'), 'translate');
  h.render();
  assert.deepEqual(chans().sort(), ['contextflow-mark-explain', 'contextflow-mark-translate']);
});

t('未知样式回落 yellow，不静默丢弃', () => {
  const h = fresh();
  h.set('a', range('x'), 'chartreuse');
  h.render();
  assert.deepEqual(chans(), ['contextflow-yellow']);
});

// 这条是重叠时视觉正确的前提：后注册者背景在上。
t('标记先于颜色注册（高亮背景须压住标记 tint）', () => {
  const h = fresh();
  h.set('a', range('x'), 'yellow');       // 故意先 set 颜色
  h.set('b', range('y'), 'explain');
  h.render();
  const ks = chans();
  assert.ok(ks.indexOf('contextflow-mark-explain') < ks.indexOf('contextflow-yellow'),
    `注册顺序应为标记在前，实际 ${JSON.stringify(ks)}`);
});

t('同通道多个 range 合并为一个 Highlight', () => {
  const h = fresh();
  h.set('a', range('x'), 'explain');
  h.set('b', range('y'), 'explain');
  h.render();
  assert.equal(CSS.highlights.get('contextflow-mark-explain').ranges.length, 2);
});

t('通道空了要删掉，不留陈旧条目', () => {
  const h = fresh();
  h.set('a', range('x'), 'explain');
  h.render();
  assert.deepEqual(chans(), ['contextflow-mark-explain']);
  h.delete('a');
  h.render();
  assert.deepEqual(chans(), []);
});

t('clear 清掉标记通道（不止颜色通道）', () => {
  const h = fresh();
  h.set('a', range('x'), 'explain');
  h.set('b', range('y'), 'pink');
  h.render();
  h.clear();
  assert.deepEqual(chans(), []);
  assert.equal(h.items.size, 0);
});

t('样式表同时声明颜色与标记规则', () => {
  const h = fresh();
  h.set('a', range('x'), 'explain');
  h.render();
  const css = document.head.querySelector('style[data-contextflow]').textContent;
  for (const c of Object.keys(COLORS)) assert.match(css, new RegExp(`contextflow-${c}\\)`));
  for (const m of Object.keys(MARKS)) {
    assert.match(css, new RegExp(`contextflow-mark-${m}\\)`));
  }
  assert.match(css, /text-decoration:underline (dotted|dashed)/);
});

t('标记与颜色的键不重叠（否则 chan 路由会歧义）', () => {
  for (const m of Object.keys(MARKS)) assert.ok(!(m in COLORS), `${m} 同时是颜色名`);
});

// ---- hitTest：原文点击的唯一命中源 ----

const pointRange = (name, len, inside = true) => ({
  toString: () => name.repeat(len),
  isPointInRange: () => inside,
});

t('hitTest：单个命中返回 id', () => {
  const h = fresh();
  h.set('a', pointRange('x', 5), 'yellow');
  document.caretPositionFromPoint = () => ({ offsetNode: {}, offset: 0 });
  assert.equal(h.hitTest(10, 20), 'a');
});

t('hitTest：重叠时取最短（最具体）的 Range', () => {
  const h = fresh();
  h.set('长', pointRange('x', 20), 'yellow');
  h.set('短', pointRange('x', 4), 'explain');
  document.caretPositionFromPoint = () => ({ offsetNode: {}, offset: 0 });
  assert.equal(h.hitTest(10, 20), '短');
});

t('hitTest：等长重叠保留 Map 插入顺序', () => {
  const h = fresh();
  h.set('先', pointRange('x', 5), 'yellow');
  h.set('后', pointRange('y', 5), 'translate');
  document.caretPositionFromPoint = () => ({ offsetNode: {}, offset: 0 });
  assert.equal(h.hitTest(0, 0), '先');
});

t('hitTest：没命中返回 null', () => {
  const h = fresh();
  h.set('a', pointRange('x', 5, false), 'yellow');
  document.caretPositionFromPoint = () => ({ offsetNode: {}, offset: 0 });
  assert.equal(h.hitTest(0, 0), null);
});

t('hitTest：caretPositionFromPoint 失败时用 caretRangeFromPoint', () => {
  const h = fresh();
  h.set('a', pointRange('x', 5), 'yellow');
  document.caretPositionFromPoint = undefined;
  document.caretRangeFromPoint = () => ({ startContainer: {}, startOffset: 0 });
  assert.equal(h.hitTest(0, 0), 'a');
});

t('hitTest：两个 caret API 都拿不到点时返回 null', () => {
  const h = fresh();
  document.caretPositionFromPoint = () => null;
  document.caretRangeFromPoint = () => null;
  assert.equal(h.hitTest(0, 0), null);
});

// ---- 两种 rect：定位用 union，删除按钮用视觉末端 ----

t('rectOf 保留 union rect（面板→原文滚动用）', () => {
  const h = fresh();
  const union = { left: 1, top: 2, right: 101, bottom: 42, width: 100, height: 40 };
  h.set('a', { getBoundingClientRect: () => union }, 'yellow');
  assert.equal(h.rectOf('a'), union);
});

t('endRectOf 返回最后一个非空 client rect（多行选区视觉末端）', () => {
  const h = fresh();
  const r1 = { left: 10, top: 10, right: 200, bottom: 28, width: 190, height: 18 };
  const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const r2 = { left: 10, top: 32, right: 80, bottom: 50, width: 70, height: 18 };
  h.set('a', { getClientRects: () => [r1, zero, r2] }, 'yellow');
  assert.equal(h.endRectOf('a'), r2);
});

t('endRectOf 全是零尺寸时回落 union rect', () => {
  const h = fresh();
  const union = { left: 1, top: 2, right: 9, bottom: 10, width: 8, height: 8 };
  h.set('a', {
    getClientRects: () => [{ width: 0, height: 0 }],
    getBoundingClientRect: () => union,
  }, 'yellow');
  assert.equal(h.endRectOf('a'), union);
});

t('rectOf / endRectOf：missing、零尺寸、异常都返回 null', () => {
  const h = fresh();
  assert.equal(h.rectOf('x'), null);
  assert.equal(h.endRectOf('x'), null);
  h.set('z', {
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    getClientRects: () => [],
  }, 'yellow');
  assert.equal(h.rectOf('z'), null);
  assert.equal(h.endRectOf('z'), null);
  h.set('bad', { getClientRects: () => { throw new Error('detached'); } }, 'yellow');
  assert.equal(h.endRectOf('bad'), null);
});

console.log(`\n${pass} 项通过`);
