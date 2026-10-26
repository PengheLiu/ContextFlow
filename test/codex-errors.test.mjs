import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodexError } from '../server/codex-app-server.mjs';
import { testAgentConnection } from '../server/agent-test.mjs';

const classify = error => classifyCodexError(error, 'turn/start');
test('Codex known provider and structured HTTP errors receive bounded, actionable categories', () => {
  const cases = [
    [{ message: 'HTTP status 401' }, 'AGENT_AUTH'],
    [{ message: 'failed', codexErrorInfo: 'unauthorized' }, 'AGENT_AUTH'],
    [{ message: JSON.stringify({ error: { code: 'invalid_api_key', message: 'invalid credential' } }) }, 'AGENT_AUTH'],
    [{ message: 'failed', codexErrorInfo: 'usageLimitExceeded' }, 'AGENT_QUOTA'],
    [{ message: 'failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } } }, 'AGENT_QUOTA'],
    [{ message: 'failed', data: { error: { code: 'insufficient_quota' } } }, 'AGENT_QUOTA'],
    [{ message: 'failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }, 'AGENT_RATE_LIMIT'],
    [{ message: JSON.stringify({ error: { code: 'model_not_found' } }) }, 'AGENT_MODEL_UNAVAILABLE'],
    [{ message: JSON.stringify({ error: { code: 'unsupported_value', param: 'reasoning.effort' } }) }, 'AGENT_REASONING_UNSUPPORTED'],
    [{ message: 'The model does not support reasoning effort xhigh' }, 'AGENT_REASONING_UNSUPPORTED'],
    [{ code: 'ECONNREFUSED', message: 'connection refused' }, 'AGENT_NETWORK'],
    [{ message: 'stream ended', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, 'AGENT_NETWORK'],
    [{ message: 'request timed out' }, 'AGENT_TIMEOUT'],
    [{ message: 'failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }, 'AGENT_PROVIDER_UNAVAILABLE'],
    [{ status: 403, message: 'forbidden' }, 'AGENT_ACCESS_DENIED'],
    [{ status: 404, message: 'route missing' }, 'AGENT_PROVIDER_REQUEST'],
    [{ code: -32602, message: 'invalid protocol params' }, 'CODEX_PROTOCOL'],
  ];
  for (const [input, expected] of cases) assert.equal(classify(input).code, expected, JSON.stringify(input));
});

test('unknown errors are not guessed from a status fragment or reflected through diagnostics', () => {
  const secret = 'Bearer PRIVATE_CREDENTIAL_123 https://private.example/note?api_key=secret';
  for (const input of [{ message: secret }, { message: '{broken JSON ' + secret }, { message: 'note 401 ' + secret },
    { message: secret, codexErrorInfo: 'futureProviderError' }, { message: secret, codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } } },
    { message: secret, data: { api_key: secret } }]) {
    const error = classify(input);
    assert.equal(error.code, 'CODEX_RPC'); assert.match(error.message, /支持代码：CODEX_RPC/);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_CREDENTIAL|private\.example|api_key|Bearer|secret/);
  }
  const failedTurn = classifyCodexError({ message: secret }, 'turn/start', 'AGENT_ERROR');
  assert.equal(failedTurn.code, 'AGENT_ERROR'); assert.match(failedTurn.message, /支持代码：AGENT_ERROR/);
});

test('classification never exposes provider credentials even when a known category matches', () => {
  const input = { message: JSON.stringify({ error: { code: 'invalid_api_key', message: 'Authorization: Bearer sk_PRIVATE credential=secret' } }) };
  const error = classify(input); assert.equal(error.code, 'AGENT_AUTH');
  assert.doesNotMatch(error.message + JSON.stringify(error), /sk_PRIVATE|credential=|Bearer|Authorization/);
});

test('only explicit unsupported startup RPC methods permit fallback, while unknown terminal failures stay terminal', () => {
  const error = classifyCodexError({ code: -32601, message: 'method missing' }, 'thread/start');
  assert.equal(error.code, 'CODEX_UNSUPPORTED'); assert.equal(error.submitted, false);
  assert.equal(classify({ code: -32601, message: 'turn method missing' }).code, 'CODEX_PROTOCOL');
});

test('connection-test messages expose useful known categories and safe support codes, including a genuinely empty response', async () => {
  const prepared = { id: 'codex', label: 'Codex CLI' };
  const categories = { AGENT_AUTH: /登录|认证/, AGENT_QUOTA: /额度|预算/, AGENT_RATE_LIMIT: /限流/,
    AGENT_MODEL_UNAVAILABLE: /默认模型/, AGENT_REASONING_UNSUPPORTED: /推理强度/, AGENT_NETWORK: /网络|代理/,
    AGENT_PROVIDER_UNAVAILABLE: /暂时不可用/, AGENT_ACCESS_DENIED: /拒绝访问/, AGENT_PROVIDER_REQUEST: /接口/,
    CODEX_PROTOCOL: /协议/, CODEX_RPC_TIMEOUT: /超时/, CODEX_DISCONNECTED: /断开/, CODEX_UNSUPPORTED: /更新/,
    CODEX_RPC: /支持代码：CODEX_RPC/, AGENT_EMPTY: /没有返回可展示/ };
  for (const [code, hint] of Object.entries(categories)) await assert.rejects(() => testAgentConnection(prepared, {
    run: async () => { throw Object.assign(new Error('sk_PRIVATE Authorization=secret'), { code }); },
  }), error => error.code === code && hint.test(error.message) && !/sk_PRIVATE|Authorization|secret/.test(error.message));
});
