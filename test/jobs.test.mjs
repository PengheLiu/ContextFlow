// 异步作业队列。
// 重点：串行（防网页刷爆本地 agent）、失败不吞、取消不再回写。
import assert from 'node:assert/strict';
import { submit, get, cancel, stats, _reset } from '../server/jobs.mjs';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
};

console.log('异步作业队列\n');

await t('提交后立刻返回，不等结果', async () => {
  _reset();
  let done = false;
  const j = submit({ kind: 'explain', label: 'x', task: async () => { await wait(80); done = true; return 'ok'; } });
  assert.ok(j.id);
  assert.equal(done, false, '同步等了');
  assert.ok(['queued', 'running'].includes(j.status));
});

await t('完成后能取到结果', async () => {
  _reset();
  const j = submit({ kind: 'k', label: 'l', task: async () => ({ answer: '答案' }) });
  assert.ok(await until(() => get(j.id)?.status === 'done'));
  assert.deepEqual(get(j.id).result, { answer: '答案' });
});

await t('失败被记录而不是吞掉', async () => {
  _reset();
  const j = submit({ kind: 'k', label: 'l', task: async () => { throw Object.assign(new Error('炸了'), { code: 'BOOM' }); } });
  assert.ok(await until(() => get(j.id)?.status === 'error'));
  assert.equal(get(j.id).error.message, '炸了');
  assert.equal(get(j.id).error.code, 'BOOM');
});

// 这条是队列存在的理由：agent 是重进程，并发起会把机器和额度一起打满
await t('串行执行：同时只有一个在跑', async () => {
  _reset();
  let concurrent = 0, peak = 0;
  const mk = () => submit({ kind: 'k', label: 'l', task: async () => {
    concurrent++; peak = Math.max(peak, concurrent);
    await wait(60); concurrent--; return 1;
  } });
  const js = [mk(), mk(), mk(), mk()];
  assert.ok(await until(() => js.every((j) => get(j.id)?.status === 'done'), 5000));
  assert.equal(peak, 1, `峰值并发 ${peak}，队列没起作用`);
});

await t('排队中的作业能报出前面还有几个', async () => {
  _reset();
  submit({ kind: 'k', label: 'l', task: async () => { await wait(150); } });
  const second = submit({ kind: 'k', label: 'l', task: async () => {} });
  assert.equal(get(second.id).status, 'queued');
  assert.ok(get(second.id).queuedAhead >= 1);
});

await t('进度可以被任务写入并读出', async () => {
  _reset();
  const j = submit({ kind: 'k', label: 'l', task: async (api) => {
    api.progress('读取笔记库…'); await wait(80); return 1;
  } });
  assert.ok(await until(() => get(j.id)?.progress.includes('读取笔记库')));
});

await t('取消排队中的作业：不会再执行', async () => {
  _reset();
  submit({ kind: 'k', label: 'l', task: async () => { await wait(120); } });
  let ran = false;
  const second = submit({ kind: 'k', label: 'l', task: async () => { ran = true; } });
  assert.equal(cancel(second.id), true);
  await wait(250);
  assert.equal(ran, false, '被取消的作业还是跑了');
  assert.equal(get(second.id).status, 'canceled');
});

await t('取消正在跑的作业：结果不再回写', async () => {
  _reset();
  const j = submit({ kind: 'k', label: 'l', task: async () => { await wait(120); return '晚到的结果'; } });
  assert.ok(await until(() => get(j.id)?.status === 'running'));
  cancel(j.id);
  await wait(200);
  assert.equal(get(j.id).status, 'canceled');
  assert.equal(get(j.id).result, null, '取消后仍然回写了结果');
});

await t('已完成的作业不能取消', async () => {
  _reset();
  const j = submit({ kind: 'k', label: 'l', task: async () => 1 });
  assert.ok(await until(() => get(j.id)?.status === 'done'));
  assert.equal(cancel(j.id), false);
});

await t('未知 id 返回 null 而不是抛错', () => assert.equal(get('不存在'), null));

await t('stats 反映队列状态', async () => {
  _reset();
  submit({ kind: 'k', label: 'l', task: async () => { await wait(120); } });
  submit({ kind: 'k', label: 'l', task: async () => {} });
  const s = stats();
  assert.equal(s.maxConcurrent, 1);
  assert.ok(s.running + s.queued >= 2);
});

await t('同步抛出的任务也被捕获（不是只处理 reject）', async () => {
  _reset();
  const j = submit({ kind: 'k', label: 'l', task: () => { throw new Error('同步炸'); } });
  assert.ok(await until(() => get(j.id)?.status === 'error'));
  assert.equal(get(j.id).error.message, '同步炸');
});

console.log(`\n${pass} 项通过`);
