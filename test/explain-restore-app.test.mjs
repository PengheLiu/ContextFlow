// 解释浮层重开：恢复同一选区最近的问题与答案，不把非空问题误成默认解释。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>Gated Residual</p></body>', { url: 'https://example.com/a' });
for (const k of ['window', 'document', 'location', 'localStorage', 'Node', 'NodeFilter', 'Range']) {
  global[k] = dom.window[k];
}
global.performance = { now: () => Date.now() };
global.scrollY = 0;
global.scrollTo = () => {};
global.getSelection = () => ({ isCollapsed: true });
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
global.requestAnimationFrame = (fn) => fn();

const { App } = await import('../src/skill/main.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
};

const event = (id, question, value, createdAt, extra = {}) => ({
  id, action: 'explain', text: 'Gated Residual', value, createdAt,
  anchor: { exact: 'Gated Residual', start: 0, end: 14 },
  extra: { question, ...extra },
});

function fakePopover() {
  return {
    open$ : true, bodyText: '', answerText: '', footText: '', focused: null, refresh: false,
    open() { return this; },
    body(v) { this.bodyText = v; return this; },
    answer(v) { this.answerText = v; return this; },
    foot(v) { this.footText = v; return this; },
    showRefresh(v) { this.refresh = v; return this; },
    focus(v = '') { this.focused = v; return this; },
  };
}

function bare(items) {
  localStorage.clear();
  const app = new App();
  const pop = fakePopover();
  app.items = items;
  app.snapshot = () => ({ anchor: { exact: 'Gated Residual', start: 0, end: 14 }, offset: 0 });
  app.hideTbSoon = () => {};
  app.tipFor = () => pop;
  return { app, pop };
}

const range = {
  toString: () => '「Gated   Residual」。',
  getBoundingClientRect: () => ({ left: 1, top: 2, bottom: 3, right: 4, width: 3, height: 1 }),
};

console.log('App：恢复历史解释\n');

await t('重开同一选区恢复最近一次问题和答案', () => {
  const old = event('old', '旧问题？', '旧答案', 10);
  const latest = event('latest', '是不是特殊形式？', '新答案', 20);
  const { app, pop } = bare([old, latest]);
  app.doExplain(range);
  assert.equal(pop.focused, '是不是特殊形式？');
  assert.equal(pop.answerText, '新答案');
  assert.equal(pop.refresh, true);
  assert.equal(app.items.length, 2, '恢复不能合并或删除其他历史问题');
});

await t('同问题直接提交命中本地，不上传、不建 pending', async () => {
  const latest = event('latest', '是不是特殊形式？', '新答案', 20);
  const { app, pop } = bare([latest]);
  app.explainCtx = { text: 'Gated Residual', anchor: latest.anchor, offset: 0 };
  let uploaded = 0, began = 0;
  app.uploadArticle = async () => { uploaded++; };
  app.beginLookup = () => { began++; throw new Error('不应创建 pending'); };
  await app.runExplain('  是不是特殊形式？  ');
  assert.equal(uploaded, 0);
  assert.equal(began, 0);
  assert.equal(pop.focused, '是不是特殊形式？');
  assert.equal(pop.answerText, '新答案');
  assert.equal(pop.refresh, true);
  assert.equal(app.items[0].value, '新答案');
});

await t('运行中的旧问题恢复问题与进度', () => {
  const running = event('run', '比较两者？', null, 30,
    { status: 'running', progress: '正在准备上下文…', jobId: 'j1' });
  const { app, pop } = bare([running]);
  app.doExplain(range);
  assert.equal(pop.focused, '比较两者？');
  assert.equal(pop.bodyText, '正在准备上下文…');
  assert.equal(pop.refresh, false);
});

console.log(`\n${pass} 项通过`);
