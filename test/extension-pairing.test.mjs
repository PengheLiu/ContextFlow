import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'contextflow-pair-test-'));
process.env.CONTEXTFLOW_DIR = directory;
const { pairExtension, extensionAuthorized } = await import('../server/extension-pairing.mjs');
const id = 'a'.repeat(32);
const origin = `chrome-extension://${id}`;
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
writeFileSync(join(directory, 'config.json'), JSON.stringify({ port, token: 'legacy-test-token', requireToken: true, allowedOrigins: [origin] }));
let server;
try {
  assert.throws(() => pairExtension('invalid'), /扩展 ID/);
  const token = pairExtension(id);
  assert.equal(token.length, 43);
  assert.equal(extensionAuthorized(origin, token), true);
  assert.equal(extensionAuthorized(origin, 'wrong'), false);
  assert.equal(readFileSync(join(directory, 'extension-pairings.json'), 'utf8').includes(token), false);
  assert.equal(statSync(join(directory, 'extension-pairings.json')).mode & 0o777, 0o600);
  server = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, CONTEXTFLOW_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = `http://127.0.0.1:${port}/health`;
  const headers = (value, source = origin) => ({ Origin: source, 'X-ContextFlow': '1', Authorization: `Bearer ${value}` });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await fetch(endpoint, { headers: headers(token), signal: AbortSignal.timeout(500) }); ready = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, '测试服务启动失败');
  assert.equal((await fetch(endpoint, { headers: headers(token) })).status, 200);
  const withoutOrigin = { 'X-ContextFlow': '1', 'X-ContextFlow-Extension': id, Authorization: `Bearer ${token}` };
  const noOriginResponse = await fetch(endpoint, { headers: withoutOrigin });
  assert.equal(noOriginResponse.status, 200);
  const serviceHealth = await noOriginResponse.json();
  assert.equal(serviceHealth.extensionPaired, true);
  assert.equal(serviceHealth.serviceVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.ok(serviceHealth.capabilities.includes('llm.test'));
  assert.ok(serviceHealth.capabilities.includes('llm.draft'));
  assert.ok(Number.isFinite(Date.parse(serviceHealth.startedAt)));
  assert.equal(serviceHealth.jobs.running, 0);
  const modelTest = await fetch(endpoint.replace('/health', '/llm/test'), { method: 'POST', headers: withoutOrigin, body: '{}' });
  assert.equal(modelTest.status, 503);
  assert.equal((await modelTest.json()).code, 'NO_API_KEY', '真实 HTTP 路由必须存在；空白配置不调用上游');
  const configBefore = readFileSync(join(directory, 'config.json'), 'utf8');
  const draftModels = await fetch(endpoint.replace('/health', '/llm/models'), { method: 'POST', headers: withoutOrigin, body: JSON.stringify({ translate: { provider: 'openai', baseUrl: 'not-a-url', model: 'draft' } }) });
  assert.equal(draftModels.status, 503);
  assert.equal((await draftModels.json()).code, 'NO_BASEURL');
  const invalidDraft = await fetch(endpoint.replace('/health', '/llm/test'), { method: 'POST', headers: withoutOrigin, body: '{"translate":null}' });
  assert.equal(invalidDraft.status, 400);
  assert.equal(readFileSync(join(directory, 'config.json'), 'utf8'), configBefore, '连接测试不得保存或改写配置');
  assert.equal((await fetch(endpoint, { headers: { ...withoutOrigin, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(endpoint, { headers: { ...withoutOrigin, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: { ...withoutOrigin, 'X-ContextFlow-Extension': 'invalid' } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: headers('wrong') })).status, 401);
  assert.equal((await fetch(endpoint, { headers: headers(token, 'https://evil.example') })).status, 403);
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const freshId = 'b'.repeat(32);
  const freshOrigin = `chrome-extension://${freshId}`;
  const freshToken = pairExtension(freshId);
  assert.equal((await fetch(endpoint, { headers: headers(freshToken, freshOrigin) })).status, 200);
  const replacement = pairExtension(id);
  assert.equal((await fetch(endpoint, { headers: headers(token) })).status, 401);
  assert.equal((await fetch(endpoint, { headers: headers(replacement) })).status, 200);
  pairExtension(id, { revoke: true });
  assert.equal((await fetch(endpoint, { headers: headers(replacement) })).status, 401);
  assert.equal((await fetch(endpoint, { headers: headers('legacy-test-token') })).status, 401);
  console.log('本地配对：哈希保存、实时授权、无需重启、跨来源拒绝、轮换与撤销 HTTP 集成测试通过');
} finally {
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  rmSync(directory, { recursive: true, force: true });
}
