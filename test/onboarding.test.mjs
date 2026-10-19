import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeRoot, resolveWithin } from '../server/paths.mjs';
import { setupStatus } from '../server/config.mjs';
import { testConnection, trimBase } from '../server/llm.mjs';
import { checkReleaseLinks } from '../tools/check-release-links.mjs';

assert.equal(normalizeRoot('~/ContextFlow'), join(homedir(), 'ContextFlow'));
assert.equal(normalizeRoot('"~/My Notes"'), join(homedir(), 'My Notes'));
assert.equal(normalizeRoot(''), '');
assert.throws(() => normalizeRoot('relative/path'), /绝对路径/);
assert.throws(() => resolveWithin('/tmp/vault', '../vault-other'), /越出根目录/);
assert.equal(resolveWithin('/tmp/vault', '/Reading'), '/tmp/vault/Reading');
assert.equal(trimBase('https://example.test/v1/chat/completions/'), 'https://example.test');
assert.equal(trimBase('https://example.test/api/v1/messages'), 'https://example.test/api');
assert.deepEqual(setupStatus({}), { llmConfigured: false, explainConfigured: false });
assert.deepEqual(setupStatus({ translate: { apiKey: 'key', model: 'm', provider: 'openai' } }), { llmConfigured: false, explainConfigured: false });
assert.deepEqual(setupStatus({ explain: { backend: 'agent' }, agent: { id: 'claude' } }), { llmConfigured: false, explainConfigured: true });
const cfg = { translate: { apiKey: 'only-test', model: 'mock-model', provider: 'openai', baseUrl: 'http://example.test' } };
assert.deepEqual(setupStatus(cfg), { llmConfigured: true, explainConfigured: true });
const published = await checkReleaseLinks('0.3.2', async (url, init) => {
  assert.equal(init.method, 'HEAD');
  assert.ok(url.startsWith('https://'));
  return { ok: true };
});
assert.equal(published.length, 3);
await assert.rejects(() => checkReleaseLinks('0.3.2', async () => ({ ok: false, status: 404 })), /先发布匹配版本/);
const original = globalThis.fetch;
try {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    assert.ok(init.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
  };
  assert.deepEqual(await testConnection(cfg), { ok: true, model: 'mock-model' });
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.messages.map((message) => message.content), ['This is a connection check. Reply only OK.', 'OK']);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid key' } }) });
  await assert.rejects(() => testConnection(cfg), /401/);
  globalThis.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(() => testConnection(cfg), /超时/);
  await assert.rejects(() => testConnection({ translate: {} }), /未配置 API key/);
  await assert.rejects(() => testConnection({ translate: { ...cfg.translate, baseUrl: 'not-a-url' } }), /http:\/\//);
} finally { globalThis.fetch = original; }
console.log('新手配置：用户目录展开、拒绝相对路径与越界、AI 配置完整性、固定消息测试及错误反馈通过');
