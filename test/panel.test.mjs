// 右侧面板：速览区与异常兜底。
//
// 这个文件的由来：速览的「重新生成」按钮绑了 this.guard(...)，而那是 Settings 上的
// 方法、Panel 根本没有 —— 抄了模式没抄实现。更糟的是它落在**成功路径**上，
// 于是一次真的跑成了的速览被显示成 "速览失败：this.guard is not a function"。
// 点一下那个按钮就会露，但当时没有任何面板测试。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>hello</p></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Range', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
global.innerWidth = 1400;
global.innerHeight = 900;
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { Panel } = await import('../src/skill/panel.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** 最小 handler 集合：只做面板渲染需要的那些 */
function handlers(over = {}) {
  return {
    getItems: () => [],
    getStats: () => ({ position: 0, quote: 0, fuzzy: 0, orphan: 0 }),
    getNote: () => '',
    isOnline: () => true,
    outbox: () => 0,
    positionOf: () => 0,
    isOrphan: () => false,
    colorOf: () => '#ffd60a',
    commentOf: () => '',
    getLookups: () => [],
    api: {},
    ...over,
  };
}
const mk = (over) => new Panel(handlers(over));

console.log('右侧面板\n');

await t('构造后四个 tab 与速览区都在', () => {
  const p = mk();
  for (const k of ['translate', 'explain', 'comments', 'note']) {
    assert.ok(p.sh.getElementById(`t-${k}`), `缺 tab ${k}`);
    assert.ok(p.sh.getElementById(`p-${k}`), `缺 pane ${k}`);
  }
  assert.ok(p.sh.getElementById('brief'), '缺速览区');
});

// ---- 这就是那个 bug ----

await t('速览区有异常兜底（Panel 自己得有 guard，不能只有 Settings 有）', () => {
  const p = mk();
  assert.equal(typeof p.guard, 'function', 'Panel 没有 guard —— 抄了模式没抄实现');
  assert.equal(typeof p.onHandlerError, 'function');
});

await t('渲染成功态并点「重新生成」不抛（原先在这里炸）', () => {
  let asked = null;
  const p = mk({ onSummarize: (fresh) => { asked = fresh; } });
  p.renderBrief({ state: 'ok', text: '这篇讲 X。', retry: true, meta: 'dsh · 2.1s' });
  const btn = p.sh.querySelector('[data-act=rebrief]');
  assert.ok(btn, '成功态没有「重新生成」按钮');
  assert.doesNotThrow(() => btn.click());
  assert.equal(asked, true, '点了按钮却没请求重新生成');
});

await t('handler 抛异常时摊到界面上，不静默', () => {
  const p = mk({ onSummarize: () => { throw new Error('炸了'); } });
  p.renderBrief({ state: 'ok', text: 'x', retry: true });
  p.sh.querySelector('[data-act=rebrief]').click();
  assert.match(p.sh.getElementById('syncmsg').textContent, /炸了/);
});

await t('async handler 的 reject 也接住（否则只剩 unhandledrejection）', async () => {
  const p = mk({ onSummarize: () => Promise.reject(new Error('异步炸')) });
  p.renderBrief({ state: 'ok', text: 'x', retry: true });
  p.sh.querySelector('[data-act=rebrief]').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(p.sh.getElementById('syncmsg').textContent, /异步炸/);
});

// 代码缺陷要说成代码缺陷，别让人去查网络
await t('TypeError 被说明成「界面代码出错」', () => {
  const p = mk({ onSummarize: () => { null.boom(); } });
  p.renderBrief({ state: 'ok', text: 'x', retry: true });
  p.sh.querySelector('[data-act=rebrief]').click();
  assert.match(p.sh.getElementById('syncmsg').textContent, /界面代码出错/);
});

// ---- 速览区的三种状态 ----

await t('运行态给脉动点（进度文字否则读起来像结论）', () => {
  const p = mk();
  p.renderBrief({ state: 'run', text: '正在生成速览…' });
  const el = p.sh.getElementById('brief');
  assert.ok(el.classList.contains('run'));
  assert.ok(el.querySelector('.dot2'), '运行态没有脉动点');
  assert.ok(!el.querySelector('[data-act=rebrief]'), '运行中还给了「重新生成」');
});

await t('失败态标红并保留重试入口', () => {
  const p = mk();
  p.renderBrief({ state: 'err', text: '速览失败：xxx', retry: true, meta: '提示' });
  const el = p.sh.getElementById('brief');
  assert.ok(el.classList.contains('err'));
  assert.ok(el.querySelector('[data-act=rebrief]'), '失败了却不给重试');
});

await t('传 null 清空速览区（CSS 的 :empty 才能把它藏掉）', () => {
  const p = mk();
  p.renderBrief({ state: 'ok', text: 'x' });
  p.renderBrief(null);
  assert.equal(p.sh.getElementById('brief').innerHTML, '');
});

await t('速览文本经过转义，页面标题里的尖括号不会变成标签', () => {
  const p = mk();
  p.renderBrief({ state: 'ok', text: '<img src=x onerror=alert(1)>' });
  const el = p.sh.getElementById('brief');
  assert.equal(el.querySelectorAll('img').length, 0, '速览内容被当成 HTML 执行了');
  assert.match(el.textContent, /<img/);
});

// ---- 打开面板的时刻 ----

await t('从收起变展开时通知一次；已经展开时不重复通知', () => {
  let n = 0;
  const p = mk({ onOpen: () => { n++; } });
  p.toggle(false);
  const base = n;
  p.toggle(true);
  assert.equal(n, base + 1, '展开时没通知');
  p.toggle(true);
  assert.equal(n, base + 1, '已经展开还重复通知了 —— 速览会被重复触发');
});

await t('收起时不通知', () => {
  let n = 0;
  const p = mk({ onOpen: () => { n++; } });
  p.toggle(true);
  const base = n;
  p.toggle(false);
  assert.equal(n, base);
});

// 面板停在别的 tab 上时，角标是"速览已生成"的唯一线索
await t('有速览时「总结」tab 出现角标', () => {
  const p = mk({ getLookups: (k) => (k === 'summary' ? [{ value: '速览内容' }] : []) });
  p.renderStatus();
  assert.equal(p.sh.getElementById('b-note').textContent, '·');
});

await t('没有速览也没有笔记时角标为空', () => {
  const p = mk();
  p.renderStatus();
  assert.equal(p.sh.getElementById('b-note').textContent, '');
});

console.log(`\n${pass} 项通过`);
