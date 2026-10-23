import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as jobs from '../server/jobs.mjs';
import { readJobStream } from '../src/core/job-stream.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(5); } throw new Error('timed out'); };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok   ${name}`); };

await test('订阅接收累计答案；成功结果是唯一完成内容，断开订阅不取消任务', async () => {
  jobs._reset(); let run, finish;
  const job = jobs.submit({ kind: 'explain', task: async api => { run = api; return new Promise(resolve => { finish = resolve; }); } });
  await until(() => run);
  const seen = [], stop = jobs.subscribe(job.id, value => seen.push(value));
  run.event({ type: 'answer', text: '部分' });
  run.event({ type: 'answer', text: '部分回答' });
  assert.deepEqual(seen.map(value => value.partialAnswer), ['部分', '部分回答']);
  assert.ok(seen[1].revision > seen[0].revision);
  assert.equal(jobs.get(job.id).result, null);
  stop(); finish({ answer: '最终答案' });
  await until(() => jobs.get(job.id).status === 'done');
  assert.equal(jobs.get(job.id).partialAnswer, '');
  assert.deepEqual(jobs.get(job.id).result, { answer: '最终答案' });
  assert.equal(seen.length, 2);
});

await test('失败与取消清除预览，晚到事件不能写回；shutdown结束订阅', async () => {
  for (const mode of ['failure', 'cancel', 'shutdown']) {
    jobs._reset(); let run, reject;
    const job = jobs.submit({ kind: 'explain', task: async api => { run = api; return new Promise((_, fail) => { reject = fail; }); } });
    await until(() => run);
    let last; jobs.subscribe(job.id, value => { last = value; });
    run.event({ type: 'answer', text: '不能保存的中间结果' });
    if (mode === 'failure') reject(new Error('failed'));
    else { if (mode === 'cancel') jobs.cancel(job.id); else jobs.shutdown(); reject(new Error('aborted')); }
    await until(() => ['error', 'canceled'].includes(jobs.get(job.id).status));
    run.event({ type: 'answer', text: '迟到内容' });
    assert.equal(last.partialAnswer, ''); assert.equal(jobs.get(job.id).partialAnswer, '');
    assert.equal(jobs.get(job.id).result, null);
  }
  jobs._reset();
});

await test('SSE按字节分块还原中文和多个事件，忽略heartbeat', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\n\ndata: {"job":{"id":"j1","status":"running","partialAnswer":"中文"}}\n\ndata: {"job":{"id":"j1","status":"done","result":{"answer":"完整"}}}\n\n');
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const seen = []; await readJobStream(response, job => seen.push(job));
  assert.equal(seen[0].partialAnswer, '中文'); assert.equal(seen[1].result.answer, '完整');
  await assert.rejects(() => readJobStream(new Response('{}'), () => {}), /不可用/);
});

await test('SSE断流超时释放reader，不能无限等待', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(() => readJobStream(response, () => {}, { idleMs: 10 }), /中断/);
  assert.equal(canceled, true);
});

const dom = new JSDOM('<!doctype html><body><p>hello</p></body>', { url: 'https://example.test', pretendToBeVisual: true });
for (const key of ['window', 'document', 'location', 'localStorage', 'HTMLElement', 'Node', 'Range', 'getComputedStyle']) globalThis[key] = dom.window[key];
globalThis.innerWidth = 1400; globalThis.innerHeight = 900;
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
const api = await import('../src/core/api.js');

await test('客户端看到增量后只返回最终结果；有流时不轮询', async () => {
  let polls = 0;
  api.setTransport(async () => { polls++; throw new Error('不应轮询'); });
  api.setStreamTransport(async (id, onJob) => {
    onJob({ id, revision: 1, status: 'running', partialAnswer: '正在生成' });
    onJob({ id, revision: 2, status: 'done', result: { answer: '完成' } });
  });
  const updates = [], result = await api.waitForJob('j1', { onProgress: job => updates.push(job) });
  assert.equal(updates[0].partialAnswer, '正在生成'); assert.equal(result.answer, '完成'); assert.equal(polls, 0);
});

await test('流失败自动读取原作业，绝不重新POST提问；失败终态不能变成答案', async () => {
  const paths = [];
  api.setTransport(async path => { paths.push(path); return { status: 200, body: { job: { id: 'j2', status: 'done', result: { answer: '恢复完成' } } } }; });
  api.setStreamTransport(async (id, onJob) => { onJob({ id, status: 'running', partialAnswer: '临时' }); throw new Error('worker reload'); });
  assert.equal((await api.waitForJob('j2')).answer, '恢复完成');
  assert.deepEqual(paths, ['/jobs/j2']);
  api.setStreamTransport(async (id, onJob) => {
    onJob({ id, status: 'running', partialAnswer: '临时' });
    onJob({ id, status: 'error', error: { code: 'UPSTREAM', message: '失败' } });
  });
  await assert.rejects(() => api.waitForJob('j2'), error => error.code === 'UPSTREAM');
});

await test('取消正在监听的任务立即发送DELETE并拒绝迟到结果', async () => {
  const controller = new AbortController(), requests = [];
  api.setTransport(async (path, init) => { requests.push({ path, method: init.method }); return { status: 200, body: { canceled: true } }; });
  api.setStreamTransport((id, onJob, signal) => new Promise(resolve => signal.addEventListener('abort', () => {
    onJob({ id, status: 'done', result: { answer: '迟到' } }); resolve();
  }, { once: true })));
  const waiting = api.waitForJob('j3', { signal: controller.signal }); controller.abort();
  await assert.rejects(() => waiting, error => error.code === 'ABORTED');
  assert.deepEqual(requests, [{ path: '/jobs/j3', method: 'DELETE' }]);
});

await test('替换已有任务的订阅只断开监听，不取消共享任务', async () => {
  const controller = new AbortController(), requests = [];
  api.setTransport(async (path, init) => { requests.push({ path, method: init?.method }); return { status: 200, body: {} }; });
  api.setStreamTransport((id, onJob, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })));
  const waiting = api.waitForJob('j3', { signal: controller.signal, cancelOnAbort: false });
  controller.abort(); await assert.rejects(() => waiting, error => error.code === 'ABORTED');
  assert.deepEqual(requests, []);
});

const { Panel } = await import('../src/skill/panel.js');
const { Popover, ticker } = await import('../src/skill/popover.js');
const old = { id: 'read-1', action: 'explain', text: '原文', value: '原来的答案', extra: { status: 'running' } };
const panel = new Panel({ getItems: () => [], getLookups: kind => kind === 'explain' ? [old] : [],
  getStats: () => ({ position: 0, quote: 0, fuzzy: 0 }), getNote: () => '', isOnline: () => true, outbox: () => 0,
  positionOf: () => 0, isOrphan: () => false, colorOf: () => '#ffd60a', commentOf: () => '', api: {},
});

await test('速览临时预览保留旧答案和取消按钮，失败清掉预览；HTML只显示文本', async () => {
  const unsafe = '<img src=x onerror=alert(1)>尚未完成';
  panel.renderBrief({ state: 'run', text: '生成中', previous: '旧速览' });
  const button = panel.$('brief').querySelector('[data-act=cancel-brief]');
  panel.renderBrief({ state: 'run', text: '正在回答', partialAnswer: unsafe });
  assert.equal(panel.$('brief').querySelector('[data-act=cancel-brief]'), button);
  assert.equal(panel.$('brief').querySelector('.stream-preview').textContent, unsafe);
  assert.equal(panel.$('brief').querySelector('.stream-preview img'), null);
  assert.match(panel.$('brief').querySelector('.previous-brief').textContent, /旧速览/);
  panel.renderBrief({ state: 'ok', text: '旧速览', meta: '生成失败' });
  assert.equal(panel.$('brief').querySelector('.stream-preview'), null);
});

await test('阅读记录预览不改变数据模型和原答案；取消清理', async () => {
  panel.toggle(true, false); panel.renderLookupPreview(old.id, '新答案的一半');
  assert.equal(old.value, '原来的答案'); assert.equal(JSON.stringify(old).includes('新答案'), false);
  assert.match(panel.records.views.get(old.id).el.querySelector('.ans').textContent, /原来的答案/);
  panel.render(); assert.equal(panel.records.views.get(old.id).el.querySelector('.stream-preview').textContent, '新答案的一半');
  panel.renderLookupPreview(old.id, ''); assert.equal(panel.records.views.get(old.id).el.querySelector('.stream-preview'), null);
});

await test('原位预览在计时器更新后保留，成功/失败显示清除预览', async () => {
  const pop = new Popover({ name: 'stream-test', title: '解释', input: true });
  pop.open({ left: 100, top: 100, bottom: 120, right: 300, width: 200, height: 20 }, '原文');
  const tk = ticker(pop, '生成中');
  pop.preview('<b>部分</b>'); tk.label('正在回答');
  assert.equal(pop.$('b').querySelector('.stream-preview').textContent, '<b>部分</b>');
  assert.equal(pop.$('b').querySelector('b'), null);
  assert.equal(tk.current, true);
  pop.body('已取消'); assert.equal(pop.$('b').querySelector('.stream-preview'), null);
  tk.stop(); pop.close();
});

await test('App只保存完成答案，失败保留旧答案；重复元数据不反复写入阅读镜像', async () => {
  const { App } = await import('../src/skill/main.js');
  for (const failed of [false, true]) {
    const app = new App(), saved = [], preview = [];
    app.items = [{ id: 'app-stream', action: 'explain', text: '原文', value: '旧答案', extra: { question: '', status: 'running' } }];
    app.online = true; app.reanchor = () => {}; app.syncExplainSubmit = () => {};
    app.persist = events => saved.push(JSON.stringify(events));
    let renders = 0;
    app.panel = { render() { renders++; }, renderLookupPreview(id, text) { preview.push(text); } };
    api.setTransport(async () => ({ status: 202, body: { mode: 'job', job: { id: 'app-job', status: 'running' } } }));
    api.setStreamTransport(async (id, onJob) => {
      onJob({ id, revision: 1, status: 'running', partialAnswer: '未完成内容' });
      onJob({ id, revision: 2, status: 'running', partialAnswer: '未完成内容继续' });
      assert.equal(renders, 1, 'partial deltas must not rerender every reading record');
      assert.equal(app.items[0].value, '旧答案');
      assert.equal(JSON.stringify(app.items).includes('未完成内容'), false);
      assert.equal(saved.join('').includes('未完成内容'), false);
      onJob(failed ? { id, revision: 3, status: 'error', error: { code: 'UPSTREAM', message: '生成失败' } }
        : { id, revision: 3, status: 'done', result: { answer: '最终答案' } });
    });
    await app.pollExplain('app-stream', { text: '原文', question: '', anchor: null });
    assert.equal(app.items[0].value, failed ? '旧答案' : '最终答案');
    assert.equal(saved.join('').includes('未完成内容'), false);
    assert.equal(preview.at(-1), '');
  }
});

console.log(`\n${passed} 项流式作业测试通过`);
dom.window.close();
