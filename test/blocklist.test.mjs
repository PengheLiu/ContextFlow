// 停用名单：页面 / 站点两级屏蔽与恢复路径。
//
// 三层各测各的：
//   · 名单本身 —— 读写归一化（utm/hash 不该让同一页判成两页）、脏数据兜底；
//   · boot —— 已停用页面首次执行绝对安静、重复执行（用户的主动敲门）弹恢复卡；
//   · App.blockHere —— 就地撤下注入、中止轮询、断开观察者，但不刷新页面。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>x</p></body>', { url: 'https://example.com/docs/article?x=1' });
for (const k of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Node', 'NodeFilter', 'Range', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
global.performance = { now: () => Date.now() };
global.scrollY = 0;
global.scrollTo = () => {};
global.getSelection = () => ({ isCollapsed: true });
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
global.requestAnimationFrame = (fn) => fn();
global.innerWidth = 1400;
global.innerHeight = 900;

const blocklist = await import('../src/skill/blocklist.js');
const { boot, App } = await import('../src/skill/main.js');
const { Highlighter } = await import('../src/core/highlight.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('停用名单\n');

const clean = () => {
  localStorage.clear();
  delete document.documentElement.dataset.contextflowLoaded;
  document.querySelectorAll('[data-contextflow]').forEach((el) => el.remove());
};

console.log('名单读写');

await t('默认未停用', () => {
  clean();
  assert.equal(blocklist.blockedScope(), null);
});

await t('blockPage 后当前页面停用', () => {
  clean();
  blocklist.blockPage();
  assert.equal(blocklist.blockedScope(), 'page');
});

await t('urlKey 归一化：utm 参数与 hash 不影响判定', () => {
  clean();
  blocklist.blockPage('https://example.com/docs/article?x=1');
  assert.equal(blocklist.blockedScope('https://example.com/docs/article?x=1&utm_source=mail#sec'), 'page');
});

await t('同站不同路径不受页面级停用影响', () => {
  clean();
  blocklist.blockPage('https://example.com/docs/article');
  assert.equal(blocklist.blockedScope('https://example.com/other'), null);
});

await t('站点级优先于页面级；解除后逐级回落', () => {
  clean();
  blocklist.blockPage();
  blocklist.blockSite();
  assert.equal(blocklist.blockedScope(), 'site');
  blocklist.unblockSite();
  assert.equal(blocklist.blockedScope(), 'page');
  blocklist.unblockPage();
  assert.equal(blocklist.blockedScope(), null);
});

await t('localStorage 脏数据按空名单处理', () => {
  clean();
  localStorage.setItem('contextflow:blocklist', '{oops');
  assert.equal(blocklist.blockedScope(), null);
  blocklist.blockPage();          // 写回合法结构，坏数据被覆盖
  assert.equal(blocklist.blockedScope(), 'page');
});

await t('unblockPageKey 直接按名单 key 移除', () => {
  clean();
  blocklist.blockPage('https://example.com/a');
  blocklist.blockPage('https://example.com/b');
  const { pages } = blocklist.blocklistEntries();
  assert.equal(pages.length, 2);
  blocklist.unblockPageKey(pages[0].key);
  assert.equal(blocklist.blocklistEntries().pages.length, 1);
});

console.log('\nboot：已停用页面的启动闸');

await t('首次执行不创建实例，页面上不留任何注入', () => {
  clean();
  blocklist.blockPage();
  assert.equal(boot({ initialPanelOpen: true, toggleExisting: true }), null);
  assert.equal(document.documentElement.dataset.contextflowLoaded, 'toggle');
  assert.equal(document.querySelectorAll('[data-contextflow]').length, 0);
});

await t('重复执行userscript弹恢复卡片', () => {
  assert.equal(boot({ initialPanelOpen: true, toggleExisting: true }), null);
  assert.ok(document.querySelector('[data-contextflow="unblock-chip"]'));
});

await t('恢复卡片点「恢复」清掉两级名单', () => {
  blocklist.blockSite();          // 页面级之上再压一层站点级
  const chip = document.querySelector('[data-contextflow="unblock-chip"]');
  chip.shadowRoot.querySelector('button.restore').onclick();
  assert.equal(blocklist.blockedScope(), null);
});

console.log('\nApp：就地停用');

/** 与 mark-delete-app.test.mjs 同款的最小 App 替身环境 */
function bare() {
  localStorage.clear();
  document.querySelectorAll('[data-contextflow]').forEach((el) => el.remove());
  const a = new App();
  a.hl = new Highlighter();
  a.panel = { render() {}, renderStatus() {} };
  return a;
}

await t('blockHere：停止实例、撤下注入、中止轮询、断开观察者', () => {
  const a = bare();
  let disconnected = 0;
  a.observer = { disconnect() { disconnected++; } };
  const ctl = new AbortController();
  a.lookupRuns.set('running', ctl);
  const host = document.createElement('div');
  host.setAttribute('data-contextflow', 'toolbar');
  document.documentElement.appendChild(host);

  a.blockHere('page');

  assert.equal(a.stopped, true);
  assert.equal(blocklist.blockedScope(), 'page');
  assert.equal(document.querySelector('[data-contextflow="toolbar"]'), null);
  assert.ok(ctl.signal.aborted);
  assert.equal(disconnected, 1);
  // 恢复卡片是停用后唯一预期的注入
  assert.ok(document.querySelector('[data-contextflow="unblock-chip"]'));
});

await t('stop 后残余监听立即返回：划词不再弹工具条', () => {
  const a = bare();
  a.blockHere('page');
  // wire() 未真正执行（start 未跑），这里直接模拟 mouseup 回调里的闸
  assert.equal(a.scheduleReanchor(), undefined);
  assert.equal(a.togglePanel(), undefined);      // 不碰已拆除的 panel，也不抛错
});

await t('push 模式停用：把 <html> 的 margin-right 还给正文', () => {
  const a = bare();
  const root = document.documentElement;
  root.style.marginRight = '360px';              // 面板展开时挤开的正文
  a.panel = { render() {}, renderStatus() {}, rootMarginBefore: '', rootTransitionBefore: '' };
  a.blockHere('page');
  assert.equal(root.style.marginRight, '');
  assert.equal(a.panel.rootMarginBefore, null);  // 已消费，不会二次还原
});

await t('扩展载体：停用页面上实例为 null 时图标点击走恢复卡', async () => {
  clean();
  blocklist.blockSite();
  assert.equal(boot(), null);                    // 扩展入口：toggleExisting=false
  // ext/app.js 的分支逻辑：app 为 null 且在名单里 → 弹卡。这里复现该调用序列
  blocklist.showUnblockChip(blocklist.blockedScope());
  assert.ok(document.querySelector('[data-contextflow="unblock-chip"]'));
});

console.log(`\n${pass} 项通过`);
