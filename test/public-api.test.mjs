// 浏览器 LLMBridge 公开 API：实测协议为 JSON 字符串。
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
global.indexedDB = indexedDB; global.IDBKeyRange = IDBKeyRange;
global.location = { href: 'https://example.com/article' };
const api = await import('../src/public/api.js');
const store = await import('../src/core/offline-store.js');

let pass = 0;
const t = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; } };
const article = { urlKey: 'pub:a', title: 'Article', url: 'https://example.com/article',
  text: 'A'.repeat(5200) + ' important conclusion ' + 'B'.repeat(1200) };

console.log('公开userscript LLMBridge\n');

await t('实测 JSON 字符串返回可解析', () => {
  assert.equal(api.normalizeBridge('{"probe":"contextflow","ok":true}', 'probe'), 'contextflow');
  assert.equal(api.normalizeBridge('```json\n{"answer":"答案"}\n```', 'answer'), '答案');
  assert.equal(api.normalizeBridge({ data: { output: { translation: '译文' } } }, 'translation'), '译文');
  assert.throws(() => api.normalizeBridge({}, 'answer'), (e) => e.code === 'LLM_BRIDGE_BAD_RESPONSE');
});

await t('health 等待延迟注入但不消耗模型调用', async () => {
  delete global.LLMBridge; let calls = 0;
  setTimeout(() => { global.LLMBridge = { chat: async () => { calls++; return '{}'; } }; }, 120);
  assert.equal((await api.health()).ok, true); assert.equal(calls, 0);
});

await t('putArticle 只存本地，不调用 bridge', async () => {
  let calls = 0; global.LLMBridge = { chat: async () => { calls++; return '{}'; } };
  const r = await api.putArticle(article);
  assert.equal(r.changed, true); assert.equal(calls, 0);
  assert.equal((await store.getOfflineArticle(article.urlKey)).text.length, article.text.length);
});

await t('翻译调用一次 bridge 并解析实测字符串协议', async () => {
  let calls = 0, prompt = '';
  global.LLMBridge = { chat: async (p, o) => { calls++; prompt = p; assert.equal(o.response_format, 'json'); return '{"translation":"你好"}'; } };
  const r = await api.translate('hello', '简体中文', article.urlKey, 5100);
  assert.equal(r.translation, '你好'); assert.equal(calls, 1);
  assert.match(prompt, /不可信资料/); assert.match(prompt, /part="2\/2"/);
});

await t('本地已有答案不再调用 bridge', async () => {
  await store.saveOfflineEvents([{ id: 'tr-cache', urlKey: article.urlKey, action: 'translate', text: 'cached', value: '缓存译文',
    extra: { target: '简体中文' }, createdAt: 2 }], { queue: false });
  let calls = 0; global.LLMBridge = { chat: async () => { calls++; return ''; } };
  const r = await api.translate('cached', '简体中文', article.urlKey, 1);
  assert.equal(r.translation, '缓存译文'); assert.equal(r.cached, 'local'); assert.equal(calls, 0);
});

await t('解释与速览返回共享 UI 所需形状', async () => {
  const replies = ['{"answer":"解释结果"}', '{"summary":"总结。"}'];
  global.LLMBridge = { chat: async () => replies.shift() };
  const ex = await api.explain({ text: 'important', question: '为什么', urlKey: article.urlKey, offset: 5200, fresh: true });
  assert.equal(ex.answer, '解释结果'); assert.equal(ex.via, 'llmbridge');
  const sm = await api.summarize({ urlKey: article.urlKey, fresh: true });
  assert.equal(sm.summary, '总结。'); assert.equal(sm.model, '浏览器 LLMBridge');
});

await t('速览硬限制 200 字', async () => {
  global.LLMBridge = { chat: async () => JSON.stringify({ summary: '长'.repeat(250) }) };
  const sm = await api.summarize({ urlKey: article.urlKey, fresh: true });
  assert.ok([...sm.summary].length <= 200);
});

await t('相同并发请求合并且 bridge 全局串行', async () => {
  let active = 0, max = 0, calls = 0;
  global.LLMBridge = { chat: async (p) => { calls++; active++; max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 15)); active--; return p.includes('translation') ? '{"translation":"T"}' : '{"answer":"E"}'; } };
  const a = api.translate('same-new', '简体中文', article.urlKey, 1);
  const b = api.translate('same-new', '简体中文', article.urlKey, 1);
  const c = api.explain({ text: 'other', question: '', urlKey: article.urlKey, offset: 1, fresh: true });
  const [ra, rb] = await Promise.all([a, b, c]);
  assert.equal(ra.translation, 'T'); assert.equal(rb.translation, 'T');
  assert.equal(calls, 2); assert.equal(max, 1);
});

console.log(`\n${pass} 项通过`);
