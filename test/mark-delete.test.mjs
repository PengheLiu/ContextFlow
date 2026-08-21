// 原文标记的就地删除按钮。
// jsdom 不做布局，但 show/hide、夹边、事件生命周期、可访问性都能测。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="outside"></div></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'getComputedStyle']) global[k] = dom.window[k];
global.innerWidth = 320;
global.innerHeight = 240;
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
let now = 1000;
global.performance = { now: () => now };

const { MarkDeleteControl } = await import('../src/skill/mark-delete.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const rect = (o = {}) => ({ left: 100, top: 100, right: 180, bottom: 118, width: 80, height: 18, ...o });

console.log('标记就地删除按钮\n');

let deleted = [];
const ctl = new MarkDeleteControl((id) => deleted.push(id));

await t('初始隐藏', () => {
  assert.equal(ctl.visible, false);
  assert.equal(ctl.openId, null);
});

await t('show 显示并保存 id / aria-label / title', () => {
  ctl.show('a', rect(), '删除此翻译记录');
  assert.equal(ctl.visible, true);
  assert.equal(ctl.openId, 'a');
  assert.equal(ctl.el.getAttribute('aria-label'), '删除此翻译记录');
  assert.equal(ctl.el.title, '删除此翻译记录');
  assert.equal(ctl.el.type, 'button');
});

await t('正常位置：摆在末段右上角、稍向外偏', () => {
  ctl.show('a', rect());
  assert.equal(ctl.el.style.left, '183px');      // right + GAP
  assert.equal(ctl.el.style.top, '82px');       // top - SIZE + 5
});

await t('右侧不够时翻到左边', () => {
  ctl.show('a', rect({ left: 280, right: 315, width: 35 }));
  assert.equal(ctl.el.style.left, '254px');      // left - GAP - SIZE
});

// 多行选区位置策略由 Highlighter.endRectOf 负责，这里确认拿到最后一行后确实按它摆
await t('多行选区传来的末行 rect 决定位置，而不是 union rect', () => {
  const lastLine = rect({ left: 20, top: 150, right: 90, bottom: 168, width: 70 });
  ctl.show('multi', lastLine);
  assert.equal(ctl.el.style.left, '93px');
  assert.equal(ctl.el.style.top, '132px');
});

await t('坐标夹在 8px 视口内', () => {
  ctl.show('a', rect({ left: -100, right: -20, top: -50 }));
  assert.equal(ctl.el.style.left, '8px');
  assert.equal(ctl.el.style.top, '8px');
  ctl.show('a', rect({ left: 310, right: 400, top: 999 }));
  assert.equal(Number.parseInt(ctl.el.style.left), 284);     // left - GAP - SIZE，仍在视口内
  assert.equal(Number.parseInt(ctl.el.style.top), 209);      // 240 - 23 - 8
});

await t('点击只删除当前 id 一次，并立即隐藏', () => {
  deleted = [];
  ctl.show('x', rect());
  ctl.el.click();
  ctl.el.click();
  assert.deepEqual(deleted, ['x']);
  assert.equal(ctl.visible, false);
  assert.equal(ctl.openId, null);
  assert.match(ctl.status.textContent, /记录已删除/);
});

await t('show 第二个 id 替换第一个，不创建第二个 host', () => {
  const before = document.querySelectorAll('[data-contextflow="mark-delete"]').length;
  ctl.show('one', rect());
  ctl.show('two', rect());
  assert.equal(ctl.openId, 'two');
  assert.equal(document.querySelectorAll('[data-contextflow="mark-delete"]').length, before);
});

await t('400ms 内的同一次 outside click 不会立刻关掉', () => {
  now = 2000;
  ctl.show('a', rect());
  now = 2200;
  document.getElementById('outside').click();
  assert.equal(ctl.visible, true);
});

await t('400ms 后 outside click 隐藏', () => {
  now = 3000;
  ctl.show('a', rect());
  now = 3500;
  document.getElementById('outside').click();
  assert.equal(ctl.visible, false);
});

await t('任意 ContextFlow host 内点击不算 outside', () => {
  const own = document.createElement('div');
  own.setAttribute('data-contextflow', 'other-ui');
  own.innerHTML = '<button id="inside">x</button>';
  document.body.appendChild(own);
  now = 4000; ctl.show('a', rect()); now = 5000;
  own.querySelector('#inside').click();
  assert.equal(ctl.visible, true);
});

await t('Escape 隐藏', () => {
  ctl.show('a', rect());
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(ctl.visible, false);
});

await t('scroll 隐藏', () => {
  ctl.show('a', rect());
  window.dispatchEvent(new window.Event('scroll'));
  assert.equal(ctl.visible, false);
});

await t('resize 隐藏', () => {
  ctl.show('a', rect());
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(ctl.visible, false);
});

await t('没有 id / rect 时等同 hide', () => {
  ctl.show('a', rect());
  ctl.show(null, rect());
  assert.equal(ctl.visible, false);
  ctl.show('a', rect());
  ctl.show('a', null);
  assert.equal(ctl.visible, false);
});

await t('样式有 focus-visible 焦点圈与合理热区', () => {
  const css = ctl.sh.querySelector('style').textContent;
  assert.match(css, /\.x:focus-visible/);
  assert.match(css, /width:23px;height:23px/);
});

console.log(`\n${pass} 项通过`);
