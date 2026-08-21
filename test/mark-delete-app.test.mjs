// App 级删除语义。
//
// 组件测试能证明 × 会回调 id，但不能证明 id 被分派到正确的删除路径、pending job 会取消、
// 晚到结果不会把记录复活。这些是「直接删」真正危险的竞态。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>x</p></body>', { url: 'https://example.com/a' });
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

const api = await import('../src/core/api.js');
const { App } = await import('../src/skill/main.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const ev = (id, action, extra = {}) => ({
  id, action, urlKey: 'https://example.com/a', url: location.href, title: 'T',
  text: id, value: action === 'highlight' ? null : 'result', createdAt: 1,
  anchor: { exact: id, prefix: '', suffix: '', start: 0, end: id.length },
  extra,
});

function bare(items = []) {
  localStorage.clear();
  const a = new App();
  a.items = items;
  a.markDelete = { hideCalls: 0, hide() { this.hideCalls++; } };
  a.panel = { render() {}, renderStatus() {} };
  a.reanchor = () => { a.reanchored = (a.reanchored || 0) + 1; };
  a.tipFor = () => ({ close() { a.closed = true; } });
  return a;
}

console.log('App：标记就地删除\n');

await t('deleteMarked：高亮分派到 deleteHighlight', () => {
  const a = bare([ev('h', 'highlight')]);
  let h = 0, q = 0;
  a.deleteHighlight = (id) => { h++; assert.equal(id, 'h'); };
  a.deleteLookup = () => { q++; };
  a.deleteMarked('h');
  assert.equal(h, 1); assert.equal(q, 0);
});

await t('deleteMarked：翻译/解释分派到 deleteLookup', () => {
  for (const action of ['translate', 'explain']) {
    const a = bare([ev('x', action)]);
    let h = 0, q = 0;
    a.deleteHighlight = () => { h++; };
    a.deleteLookup = (id) => { q++; assert.equal(id, 'x'); };
    a.deleteMarked('x');
    assert.equal(h, 0); assert.equal(q, 1);
  }
});

await t('deleteMarked：未知/已消失 id no-op', () => {
  const a = bare([]);
  let n = 0;
  a.deleteHighlight = a.deleteLookup = () => { n++; };
  a.deleteMarked('missing');
  assert.equal(n, 0);
});

await t('删除高亮连带删除它的 comment', async () => {
  const calls = [];
  api.setTransport(async (path, init) => {
    calls.push({ path, method: init?.method });
    return { status: 200, body: {} };
  });
  const h = ev('h', 'highlight');
  const c = { ...ev('c', 'comment'), parentId: 'h', value: 'comment' };
  const a = bare([h, c]);
  a.deleteHighlight('h');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(a.items, []);
  assert.deepEqual(calls.map((x) => x.path).sort(), ['/events/c', '/events/h']);
  assert.ok(a.reanchored);
  assert.ok(a.markDelete.hideCalls);
});

await t('删除普通 lookup：本地立即消失并请求软删', async () => {
  const calls = [];
  api.setTransport(async (path, init) => { calls.push({ path, method: init?.method }); return { status: 200, body: {} }; });
  const a = bare([ev('tr', 'translate')]);
  a.deleteLookup('tr');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.items.length, 0);
  assert.ok(calls.some((x) => x.path === '/events/tr' && x.method === 'DELETE'));
});

await t('删除 pending explain：abort 本地轮询 + cancel 服务端 job', async () => {
  const calls = [];
  api.setTransport(async (path, init) => { calls.push({ path, method: init?.method }); return { status: 200, body: { canceled: true } }; });
  const p = ev('ex', 'explain', { status: 'running', jobId: 'j7' });
  p.value = null;
  const a = bare([p]);
  const ctl = new AbortController();
  a.lookupRuns.set('ex', ctl);
  a.watching = 'ex';
  a.deleteLookup('ex');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctl.signal.aborted, true);
  assert.equal(a.lookupRuns.has('ex'), false);
  assert.equal(a.closed, true, '正在看的解释浮层没关闭');
  assert.ok(calls.some((x) => x.path === '/jobs/j7' && x.method === 'DELETE'), '没 cancel job');
  assert.ok(calls.some((x) => x.path === '/events/ex' && x.method === 'DELETE'), '没删 event');
});

await t('cancelJob 失败不阻塞本地删除', async () => {
  api.setTransport(async (path) => {
    if (path.startsWith('/jobs/')) return { status: 500, body: { error: 'cancel failed' } };
    return { status: 200, body: {} };
  });
  const p = ev('ex', 'explain', { status: 'running', jobId: 'j7' }); p.value = null;
  const a = bare([p]);
  assert.doesNotThrow(() => a.deleteLookup('ex'));
  assert.equal(a.items.length, 0);
});

await t('晚到 explain 结果不能复活已删除记录', async () => {
  let resolveExplain;
  const answer = new Promise((r) => { resolveExplain = r; });
  // api.explain 先 POST /explain。用 mode != job 的同步结果，但故意晚到
  api.setTransport(async (path) => {
    if (path === '/explain') return answer;
    return { status: 200, body: {} };
  });
  const p = ev('ex', 'explain', { status: 'running' }); p.value = null;
  const a = bare([p]);
  a.saveLookup = () => { a.saved = true; };
  a.patchLookup = () => { a.patched = true; };
  const run = a.pollExplain('ex', { text: 'x', question: 'q', anchor: p.anchor, offset: 0 });
  a.deleteLookup('ex');
  resolveExplain({ status: 200, body: { answer: '晚到答案', question: 'q' } });
  await run;
  assert.equal(a.saved, undefined, '晚到结果把已删除记录复活了');
  assert.equal(a.patched, undefined, 'abort 被写成了错误记录');
  assert.equal(a.items.length, 0);
});

console.log(`\n${pass} 项通过`);
