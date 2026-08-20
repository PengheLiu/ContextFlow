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

console.log(`\n${pass} 项通过`);
