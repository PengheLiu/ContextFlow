// 解释浮层重开：恢复同一选区最近的问题与答案，不把非空问题误成默认解释。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>Gated Residual</p></body>', { url: 'https://example.com/a' });
for (const k of ['window', 'document', 'location', 'localStorage', 'Node', 'NodeFilter', 'Range']) {
  global[k] = dom.window[k];
}
global.performance = { now: () => Date.now() };
global.innerHeight = 900;
global.scrollY = 0;
global.scrollTo = () => {};
global.getSelection = () => ({ isCollapsed: true });
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
global.requestAnimationFrame = (fn) => fn();

const { App } = await import('../src/skill/main.js');
const api = await import('../src/core/api.js');

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
    question() { return this.focused || ''; },
    progress(v) { this.bodyText = v; return this; },
    submitState(label, busy) { this.submitLabel = label; this.busy = busy; return this; },
    supplement(id, value) { this.supplementId = id; this.supplementValue = value; return this; },
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
  app.pops = { explain: pop };
  app.reanchor = () => {};
  app.persist = () => {};
  app.panel = { render() {} };
  app.online = true;
  app.uploadArticle = async () => {};
  return { app, pop };
}

const range = {
  toString: () => '「Gated   Residual」。',
  getBoundingClientRect: () => ({ left: 1, top: 2, bottom: 3, right: 4, width: 3, height: 1 }),
};

console.log('App：恢复历史解释\n');

await t('已配置 AI 时展开侧栏也只显示生成入口，不上传正文或调用模型', async () => {
  const { app } = bare([]);
  const prompts = [], requests = [];
  app.panel.renderBrief = value => prompts.push(value);
  app.serviceInfo = { explainConfigured: true };
  app.index = { text: '长文'.repeat(3000) };
  app.uploadArticle = async () => { throw new Error('不应上传正文'); };
  api.setTransport(async path => { requests.push(path); throw new Error('不应请求模型'); });
  await app.autoSummarize();
  app.handlers().onOpen();
  await Promise.resolve();
  assert.deepEqual(requests, []);
  assert.equal(prompts.at(-1).initial, true);
  assert.match(prompts.at(-1).text, /按需生成/);
  app.items = [{ action: 'summary', value: '已生成的速览' }];
  await app.autoSummarize();
  assert.equal(prompts.at(-1).text, '已生成的速览');
  assert.deepEqual(requests, []);
});

await t('侧栏定位优先滚动 Range 所在正文容器并闪烁标记', () => {
  const { app } = bare([]);
  const calls = [];
  app.hl = {
    rectOf(id) { calls.push(['rect', id]); return { top: 630, width: 20, height: 10 }; },
    scrollIntoView(id) { calls.push(['into-view', id]); return true; },
    flash(id) { calls.push(['flash', id]); },
  };
  global.scrollTo = (options) => calls.push(['window-scroll', options]);
  app.handlers().onLocate('explained');
  assert.deepEqual(calls, [
    ['rect', 'explained'],
    ['into-view', 'explained'],
    ['flash', 'explained'],
  ]);
});

await t('Range 元素不能滚动时回退到 window 坐标定位', () => {
  const { app } = bare([]);
  const calls = [];
  app.hl = {
    rectOf: () => ({ top: 630, width: 20, height: 10 }),
    scrollIntoView: () => false,
    flash: (id) => calls.push(['flash', id]),
  };
  global.scrollY = 120;
  global.scrollTo = (options) => calls.push(['scroll', options]);
  app.locate('explained');
  assert.deepEqual(calls, [
    ['scroll', { top: 435, behavior: 'smooth' }],
    ['flash', 'explained'],
  ]);
});

await t('侧栏定位没有可用 Range 时不伪造滚动', () => {
  const { app } = bare([]);
  let scrolled = false, flashed = false;
  app.hl = { rectOf: () => null, flash: () => { flashed = true; } };
  global.scrollTo = () => { scrolled = true; };
  app.handlers().onLocate('orphan');
  assert.equal(scrolled, false);
  assert.equal(flashed, false);
});

await t('重开同一选区恢复最近一次问题和答案', () => {
  const old = event('old', '旧问题？', '旧答案', 10);
  const latest = event('latest', '是不是特殊形式？', '新答案', 20);
  const { app, pop } = bare([old, latest]);
  app.doExplain(range);
  assert.equal(pop.focused, '是不是特殊形式？');
  assert.equal(pop.answerText, '新答案');
  assert.equal(pop.refresh, true);
  assert.equal(pop.submitLabel, '重新解释');
  assert.equal(app.items.length, 2, '恢复不能合并或删除其他历史问题');
});

await t('同问题顶部提交重新请求，保留记录 ID、锚点和补充内容', async () => {
  const latest = event('latest', '是不是特殊形式？', '旧答案', 20, { supplement: '我的补充 ![图](contextflow-asset:abc)' });
  const { app, pop } = bare([latest]);
  app.doExplain(range);
  let uploaded = 0;
  const requests = [];
  app.uploadArticle = async () => { uploaded++; };
  api.setTransport(async (path, init) => {
    requests.push({ path, body: JSON.parse(init.body) });
    return { status: 200, body: { answer: '重新生成的答案' } };
  });
  await app.runExplain('  是不是特殊形式？  ');
  assert.equal(uploaded, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/explain');
  assert.equal(requests[0].body.fresh, true);
  assert.equal(requests[0].body.question, '是不是特殊形式？');
  assert.equal(pop.answerText, '重新生成的答案');
  assert.equal(pop.submitLabel, '重新解释');
  assert.equal(pop.busy, false);
  assert.equal(pop.refresh, true);
  assert.equal(app.items.length, 1);
  assert.equal(app.items[0].id, latest.id);
  assert.equal(app.items[0].createdAt, latest.createdAt);
  assert.deepEqual(app.items[0].anchor, latest.anchor);
  assert.equal(app.items[0].extra.supplement, latest.extra.supplement);
});

await t('改成新问题恢复提问，不强制刷新另一条历史答案', async () => {
  const { app, pop } = bare([event('old', '旧问题', '旧答案', 20)]);
  app.doExplain(range);
  pop.focus('新问题');
  app.syncExplainSubmit();
  assert.equal(pop.submitLabel, '提问');
  assert.equal(pop.refresh, false);
  let sent;
  api.setTransport(async (path, init) => {
    sent = JSON.parse(init.body);
    return { status: 200, body: { answer: '新答案' } };
  });
  await app.runExplain(pop.question());
  assert.equal(sent.fresh, false);
  assert.equal(sent.question, '新问题');
  assert.equal(app.items.length, 2);
  assert.equal(app.items.find((e) => e.id === 'old').value, '旧答案');
});

await t('上传阶段立即反馈，连续提交同一问题不会重复请求', async () => {
  const { app, pop } = bare([event('old', '为什么', '旧答案', 20)]);
  app.doExplain(range);
  let release, uploads = 0, requests = 0;
  app.uploadArticle = () => { uploads++; return new Promise((r) => { release = r; }); };
  api.setTransport(async () => { requests++; return { status: 200, body: { answer: '新答案' } }; });
  const run = app.runExplain('为什么');
  try {
    assert.equal(pop.submitLabel, '处理中…');
    assert.equal(pop.busy, true);
    assert.equal(pop.bodyText, '正在准备上下文');
    await app.runExplain(' 为什么？ ', true);
    assert.equal(uploads, 1);
  } finally { release(); await run; }
  assert.equal(requests, 1);
  assert.equal(pop.busy, false);
});

await t('上传失败会显示原因并恢复提交按钮，保留旧记录', async () => {
  const { app, pop } = bare([event('old', '', '旧答案', 20)]);
  app.doExplain(range);
  app.uploadArticle = async () => { throw new Error('连接失败'); };
  await app.runExplain('');
  assert.match(pop.bodyText, /连接失败/);
  assert.equal(pop.busy, false);
  assert.equal(app.items[0].value, '旧答案');
});

await t('未登录作业显示错误而非离线或答案，并可从顶部重试', async () => {
  const { app, pop } = bare([]);
  app.doExplain(range);
  api.setTransport(async (path) => ({ status: 200, body: path === '/explain'
    ? { mode: 'job', job: { id: 'j1' } }
    : { job: { status: 'error', error: { code: 'AGENT_AUTH', message: 'Claude Code 尚未登录' } } } }));
  await app.runExplain('');
  assert.equal(app.items[0].value, null);
  assert.equal(app.items[0].extra.status, 'error');
  assert.match(pop.bodyText, /尚未登录/);
  assert.match(pop.footText, /\/login/);
  assert.equal(pop.submitLabel, '重试');
  assert.equal(pop.busy, false);
  api.setTransport(async (path, init) => {
    assert.equal(JSON.parse(init.body).fresh, true);
    return { status: 200, body: { answer: '登录后的答案' } };
  });
  await app.runExplain('');
  assert.equal(pop.answerText, '登录后的答案');
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
