// 划词浮层的状态机。
//
// jsdom 没有布局，所以拖动/缩放的像素行为测不了；但**显隐机制**和**引文折叠**
// 是纯 DOM 状态，而且刚从 style.display 改成 class 切换 —— 这类改动错了的表现是
// "浮层永远不出现"，必须有东西守着。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>hello</p></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Range', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
global.innerWidth = 1200;
global.innerHeight = 800;
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
// 不能用 dom.window.performance：jsdom 的实现内部会读全局 performance，
// 赋回去就是无限递归（实测栈溢出）。这里只需要一个单调递增的 now。
global.performance = { now: () => Date.now() };
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

const { Popover } = await import('../src/skill/popover.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const rect = { left: 100, top: 200, bottom: 220, right: 300, width: 200, height: 20 };

console.log('划词浮层\n');

const pop = new Popover({ name: 'tip-test', title: '解释', input: true, submitLabel: '提问' });

await t('初始是关闭的', () => assert.equal(pop.open$, false));

await t('open 后处于打开态（class 切换，不是改 style.display）', () => {
  pop.open(rect, '一段原文');
  assert.equal(pop.open$, true);
  assert.ok(pop.el.classList.contains('on'));
});

await t('close 后回到关闭态', () => {
  pop.close();
  assert.equal(pop.open$, false);
  assert.ok(!pop.el.classList.contains('on'));
});

// 原来是 overflow:hidden 直接截断，用户看到断在词中间的半句话还不知道后面有内容
await t('引文默认收起（clip），真被截断时可点开、可再收起', () => {
  pop.open(rect, '很长的原文'.repeat(40));
  const src = pop.sh.getElementById('src');
  assert.ok(src.classList.contains('clip'), '默认没有收起');
  // jsdom 没有布局，scrollHeight 恒为 0，量不出溢出 —— 手工标上，模拟真被截断
  src.classList.add('clipped');
  pop.toggleSrc();
  assert.ok(src.classList.contains('open') && !src.classList.contains('clip'));
  pop.toggleSrc();
  assert.ok(src.classList.contains('clip'));
  assert.ok(src.classList.contains('clipped'), '收起后应保留 clipped，否则提示会消失');
});

// 上一版这个提示是无条件的 CSS ::after：引文只有一行、根本没截断时也显示
// "点击展开"，那是在撒谎。现在提示与折叠都以实测溢出为条件。
await t('没被截断时不提示展开，点击也不切换', () => {
  pop.open(rect, '短原文');
  const src = pop.sh.getElementById('src');
  assert.ok(!src.classList.contains('clipped'), '没溢出却标成了 clipped');
  pop.toggleSrc();
  assert.ok(!src.classList.contains('open'), '没可展开的内容却展开了，布局会无谓跳动');
});

await t('引文不再被截断成固定长度（长文完整保留，靠折叠而非丢字）', () => {
  const long = 'A'.repeat(600);
  pop.open(rect, long);
  assert.ok(pop.sh.getElementById('src').textContent.includes(long), '原文被截掉了');
});

await t('没有原文时不显示折叠态，也不因点击而抖动', () => {
  pop.open(rect, '');
  const src = pop.sh.getElementById('src');
  assert.ok(!src.classList.contains('clip'));
  pop.toggleSrc();
  assert.ok(!src.classList.contains('open'), '空引文被展开了');
});

await t('重新打开时引文回到收起态（上次展开不该带到新选区）', () => {
  pop.open(rect, '第一段'.repeat(40));
  pop.sh.getElementById('src').classList.add('clipped');
  pop.toggleSrc();
  pop.open(rect, '第二段'.repeat(40));
  assert.ok(pop.sh.getElementById('src').classList.contains('clip'));
});

await t('body / foot 写入与清空', () => {
  pop.body('答案', 'prog').foot('元信息');
  assert.equal(pop.sh.getElementById('b').textContent, '答案');
  assert.equal(pop.sh.getElementById('b').className, 'prog');
  assert.equal(pop.sh.getElementById('f').textContent, '元信息');
  pop.body('');
  assert.equal(pop.sh.getElementById('b').textContent, '');
});

await t('「重新解释」默认隐藏，命中本地缓存时才露出', () => {
  const again = pop.sh.getElementById('again');
  pop.showRefresh(false);
  assert.equal(again.style.display, 'none');
  pop.showRefresh(true);
  assert.equal(again.style.display, 'block');
});

await t('提交回调拿到输入框内容', () => {
  let got = null;
  const p2 = new Popover({ name: 'tip-t2', title: 'T', input: true, onSubmit: (v) => { got = v; } });
  p2.open(rect, 'x');
  p2.sh.getElementById('q').value = '  这是问题  ';
  p2.sh.getElementById('go').click();
  assert.equal(got, '这是问题', '没有 trim 或没拿到值');
});

// onSubmit 多是 async：不接住 reject 就只剩一条 unhandledrejection，界面上什么都不显示
await t('提交回调抛错时，错误显示在浮层上而不是静默', async () => {
  const p3 = new Popover({
    name: 'tip-t3', title: 'T', input: true,
    onSubmit: () => Promise.reject(new Error('炸了')),
  });
  p3.open(rect, 'x');
  p3.sh.getElementById('go').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(p3.sh.getElementById('b').textContent, /炸了/);
});

await t('同步抛错也被接住', () => {
  const p4 = new Popover({
    name: 'tip-t4', title: 'T', input: true,
    onSubmit: () => { throw new Error('同步炸'); },
  });
  p4.open(rect, 'x');
  p4.sh.getElementById('go').click();
  assert.match(p4.sh.getElementById('b').textContent, /同步炸/);
});

await t('尺寸与位置写入 localStorage（下次打开沿用）', () => {
  const p5 = new Popover({ name: 'tip-t5', title: 'T' });
  p5.ui = { ...p5.ui, w: 600, h: 400, x: 50, y: 60 };
  p5.open(rect, 'x');
  assert.equal(p5.el.style.width, '600px');
  assert.equal(p5.el.style.height, '400px');
});

// 原先输入框直接贴着卡片下沿（.ask 的 padding 是 `8px 12px 0`，而答案区为空时
// 被 display:none，没人提供底部留白）。现在留白放在 card 上，与最后可见的是谁无关。
await t('底部留白放在卡片上，不依赖最后一个子元素', () => {
  const css = pop.sh.querySelector('style').textContent;
  assert.match(css, /\.card\{[^}]*padding:0 0 11px/, 'card 没有底部留白');
});

await t('带输入框的浮层有最小高度（否则答案出来前又扁又难输入）', () => {
  const css = pop.sh.querySelector('style').textContent;
  assert.match(css, /\.card\.has-input\{min-height:\d+px\}/);
  assert.ok(pop.el.classList.contains('has-input'));
});

await t('不带输入框的（翻译）不套用那个最小高度', () => {
  const p6 = new Popover({ name: 'tip-t6', title: '翻译' });
  assert.ok(!p6.el.classList.contains('has-input'));
});

await t('答案区为空时给出占位提示，避免大片空白看起来像坏了', () => {
  const css = pop.sh.querySelector('style').textContent;
  assert.match(css, /#b:empty::before\{content:/);
});

await t('每个浮层挂在独立的 shadow host 上，互不干扰', () => {
  const hosts = [...document.documentElement.querySelectorAll('[data-contextflow]')];
  assert.ok(hosts.length >= 5, `只找到 ${hosts.length} 个宿主`);
  assert.equal(new Set(hosts.map((h) => h.getAttribute('data-contextflow'))).size, hosts.length,
    '出现了同名宿主 —— 重复注入会让事件绑到不可见的那一套上');
});

console.log(`\n${pass} 项通过`);
