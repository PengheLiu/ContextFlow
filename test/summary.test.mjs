// 速览 + 共享对话历史 + agent 降级。
//
// 这三件事错了都**不报错，只是静默变差**：
//   · 历史没共享 → 解释看不到速览，等于白建了那条对话
//   · 降级没生效 → 卸掉 agent 后功能整个不可用，而不是退回 LLM
//   · 速览没缓存 → 每次展开面板都起一次 agent（几十秒、花钱）
// 所以必须有东西守着。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'cf-sum-'));
process.env.CONTEXTFLOW_DIR = DIR;
const db = await import('../server/db.mjs');
const lookup = await import('../server/lookup.mjs');
const { _clampSummary, LOOKUP_LIMITS } = lookup;
const { buildMessages, turnMessage } = await import('../server/convo.mjs');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const ev = (o) => ({
  urlKey: 'art:1', url: 'u', title: 'T', text: '', value: null,
  anchor: null, createdAt: Date.now(), ...o,
});

console.log('速览 / 共享历史 / 降级\n');

// ---- 共享对话历史 ----

await t('走 agent 时：agent 那条对话含 总结+解释，不含翻译', () => {
  assert.deepEqual(lookup.convoActions(true, true), ['summary', 'explain']);
});

await t('走 agent 时：LLM 那条对话只有翻译（翻译始终走 LLM）', () => {
  assert.deepEqual(lookup.convoActions(true, false), ['translate']);
});

await t('纯 LLM 时：三类共享一条对话（前缀最长、缓存复用最充分）', () => {
  assert.deepEqual(lookup.convoActions(false, false), ['summary', 'explain', 'translate']);
  assert.deepEqual(lookup.convoActions(false, true), ['summary', 'explain', 'translate']);
});

// 翻译路由必须把 plan().viaAgent 传给 lookup.translate。若没传，默认 false，
// agent 明明在用，LLM 翻译对话里却会混进 agent 的总结/解释 —— 缓存前缀和上下文都错。
await t('服务端翻译路由把 viaAgent 传给 lookup.translate（回归）', () => {
  const src = readFileSync('server/index.mjs', 'utf8');
  const route = src.slice(src.indexOf("path === '/translate'"), src.indexOf("path === '/article'"));
  assert.match(route, /const \{ viaAgent \} = await lookup\.plan\(cfg\)/,
    'translate 路由没有先 plan(cfg)');
  assert.match(route, /lookup\.translate\(\{[^}]*viaAgent/s,
    'translate 路由没有把 viaAgent 传下去');
});

await t('lookupHistory 收多个 action，按时间升序', () => {
  db.upsertEvents([
    ev({ id: 'sm1', action: 'summary', value: '速览内容', createdAt: 1000 }),
    ev({ id: 'ex1', action: 'explain', text: 'A', value: '答A', createdAt: 2000, extra: { question: 'q' } }),
    ev({ id: 'tr1', action: 'translate', text: 'B', value: '译B', createdAt: 3000, extra: { target: 'zh' } }),
  ]);
  const ids = db.lookupHistory('art:1', ['summary', 'explain']).map((e) => e.id);
  assert.deepEqual(ids, ['sm1', 'ex1'], '取错了或顺序不对');
  assert.deepEqual(db.lookupHistory('art:1', ['translate']).map((e) => e.id), ['tr1']);
  assert.equal(db.lookupHistory('art:1', []).length, 0);
});

// 用户给的对话形状：前5k+尾1k → 总结 → 解释1 → 解释2 → 第二个5k → 解释3
await t('对话形状：速览是第一轮，之后的解释接在它后面', () => {
  const article = { title: 'T', url: 'u', text: 'x'.repeat(20000) };
  const history = db.lookupHistory('art:1', ['summary', 'explain']);
  const r = buildMessages({
    article, history, chunkChars: 5000, tailChars: 1000,
    current: { action: 'explain', text: 'sel', anchor: { start: 100 }, extra: { question: 'q2' } },
  });
  const roles = r.messages.map((m) => m.role).join(',');
  assert.equal(roles, 'user,user,assistant,user,assistant,user');
  assert.match(r.messages[0].content, /<article part="1\//, '第一条不是正文首段');
  assert.match(r.messages[0].content, /<article-tail/, '首段没附结尾节选');
  assert.match(r.messages[1].content, /200 字以内概述/, '第二条不是总结请求');
  assert.equal(r.messages[2].content, '速览内容');
});

await t('选区落在第二段时才追加第二个 5k', () => {
  const article = { title: 'T', url: 'u', text: 'x'.repeat(20000) };
  const near = buildMessages({
    article, history: [], chunkChars: 5000,
    current: { action: 'explain', text: 's', anchor: { start: 100 }, extra: {} },
  });
  const far = buildMessages({
    article, history: [], chunkChars: 5000,
    current: { action: 'explain', text: 's', anchor: { start: 7000 }, extra: {} },
  });
  assert.equal(near.chunks, 1);
  assert.equal(far.chunks, 2, '选区在第二段却没补上那一段');
});

// ---- 速览 ----

await t('速览的提问明确要求 200 字以内', () =>
  assert.match(turnMessage({ action: 'summary' }).content, /200 字以内/));

await t('没有正文时报 NEED_TEXT（而不是憑空编）', async () => {
  await assert.rejects(
    () => lookup.summarize({ urlKey: 'art:没正文', cfg: { translate: {} } }),
    (e) => { assert.equal(e.code, 'NEED_TEXT'); return true; },
  );
});

await t('已有速览直接读缓存，不打上游', async () => {
  db.putArticleText('art:1', { hash: 'h', title: 'T', url: 'u', text: 'y'.repeat(3000) });
  const r = await lookup.summarize({ urlKey: 'art:1', cfg: { translate: {}, explain: {} } });
  assert.equal(r.cached, 'local');
  assert.equal(r.summary, '速览内容');
});

await t('fresh=true 跳过缓存（会真去调上游，所以这里只断言它不再返回缓存）', async () => {
  // 没配 LLM，所以必然抛错 —— 关键是错误不是"命中缓存"
  await assert.rejects(
    () => lookup.summarize({ urlKey: 'art:1', fresh: true, cfg: { translate: {}, explain: {} } }),
    (e) => { assert.notEqual(e.code, undefined); return true; },
  );
});

// ---- 降级 ----

await t('未配 agent → 退回 LLM 并说明原因', async () => {
  const p = await lookup.plan({ explain: { backend: 'agent' }, agent: {} });
  assert.equal(p.mode, 'sync');
  assert.equal(p.viaAgent, false);
  assert.match(p.degraded, /未选择本地 agent/);
});

await t('配了不存在的 agent → 退回 LLM', async () => {
  const p = await lookup.plan({ explain: { backend: 'agent' }, agent: { id: '不存在的' } });
  assert.equal(p.viaAgent, false);
  assert.ok(p.degraded, '降级了却没说原因');
});

await t('backend=llm → 本来就是 LLM，不算降级', async () => {
  const p = await lookup.plan({ explain: { backend: 'llm' }, agent: { id: 'claude' } });
  assert.equal(p.mode, 'sync');
  assert.equal(p.degraded, '', '没降级却报了降级');
});

await t('配了本机真装着的 agent → 走 job', async () => {
  const { detect } = await import('../server/agent.mjs');
  const avail = (await detect()).find((a) => a.available);
  if (!avail) { console.log('       （本机没装任何 agent，跳过）'); return; }
  const p = await lookup.plan({ explain: { backend: 'agent' }, agent: { id: avail.id } });
  assert.equal(p.mode, 'job');
  assert.equal(p.viaAgent, true);
  assert.equal(p.degraded, '');
});

rmSync(DIR, { recursive: true, force: true });
// ---- 长度兜底 ----
//
// 模型对"字数"这种约束天生不擅长：实测 dsh 稳定在 290 字左右，改成句数约束
// 也只是好一点。所以留一道零成本的裁剪（再调一次让它缩写要多花钱和几十秒）。
// 但**按句边界裁** —— 拦腰切断比多几十个字难受得多。

await t('不超限的原样返回', () => {
  const r = _clampSummary('这篇讲 X。结论是 Y。');
  assert.equal(r.trimmed, false);
  assert.equal(r.text, '这篇讲 X。结论是 Y。');
});

await t('超限时裁到硬上限以内，且切在句末', () => {
  const r = _clampSummary('这是一句话。'.repeat(60));
  assert.equal(r.trimmed, true);
  assert.ok([...r.text].length <= LOOKUP_LIMITS.SUMMARY_HARD);
  assert.ok(/。$/.test(r.text), `没切在句末：${JSON.stringify(r.text.slice(-6))}`);
});

await t('英文句号也认', () => {
  const r = _clampSummary('This is a sentence. '.repeat(30));
  assert.equal(r.trimmed, true);
  assert.ok(/\.$/.test(r.text));
});

await t('句边界太靠前时硬截并加省略号，仍保证 <=200', () => {
  const r = _clampSummary(`开头。${'字'.repeat(400)}`);
  assert.equal(r.trimmed, true);
  assert.ok([...r.text].length <= 200);
  assert.ok(r.text.endsWith('…'));
});

await t('完全没有句末标点也硬截，仍保证 <=200', () => {
  const r = _clampSummary('字'.repeat(400));
  assert.equal(r.trimmed, true);
  assert.equal([...r.text].length, 200);
  assert.ok(r.text.endsWith('…'));
});

await t('空值不抛', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.doesNotThrow(() => _clampSummary(v));
    assert.equal(_clampSummary(v).text, '');
  }
});

console.log(`\n${pass} 项通过`);
