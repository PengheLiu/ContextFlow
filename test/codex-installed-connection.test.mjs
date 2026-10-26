// Optional installed-binary gate. Every model response comes from loopback;
// the child's HOME/CODEX_HOME contain only this fixture, never personal auth,
// MCP, hooks or instructions. No OpenAI account or paid model is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createCodexRuntime, resolveCodexExecutable } from '../server/codex-app-server.mjs';
import { agentEnvironment, execAgent } from '../server/platform.mjs';
import { testAgentConnection } from '../server/agent-test.mjs';

const binary = resolveCodexExecutable(process.env, process.env.CONTEXTFLOW_CODEX_BIN);
let version = '';
try { version = (await promisify(execAgent)(binary, ['--version'], { env: agentEnvironment(process.env), timeout: 5000 })).stdout.trim(); }
catch { /* Optional gate: ordinary unit tests do not require Codex installed. */ }
const fixtures = [
  { name: 'a real successful response', text: 'OK' },
  { name: 'a completed response without assistant output', empty: true, code: 'AGENT_EMPTY', hint: /没有返回可展示/ },
  { name: 'an unsupported reasoning effort', status: 400, error: { code: 'unsupported_value', param: 'reasoning.effort', message: 'Fixture: reasoning effort xhigh is unsupported' }, code: 'AGENT_REASONING_UNSUPPORTED', hint: /推理强度/ },
  { name: 'an unavailable model', status: 404, error: { code: 'model_not_found', message: 'Fixture model does not exist' }, code: 'AGENT_MODEL_UNAVAILABLE', hint: /默认模型/ },
  { name: 'an authentication failure', status: 401, error: { code: 'invalid_api_key', message: 'Authorization: Bearer sk_PRIVATE_FIXTURE' }, code: 'AGENT_AUTH', hint: /认证|登录/ },
  { name: 'an exhausted quota', status: 402, error: { code: 'insufficient_quota', message: 'Fixture quota exceeded' }, code: 'AGENT_QUOTA', hint: /额度|预算/ },
  { name: 'a request rate limit', status: 429, error: { code: 'rate_limit_exceeded', message: 'Fixture rate limit' }, code: 'AGENT_RATE_LIMIT', hint: /限流/ },
];

test(`installed ${version || 'Codex (not found)'} connection protocol with a local fake provider`, { skip: !/^codex-cli\s/.test(version), timeout: 30_000 }, async t => {
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    const home = await mkdtemp(join(tmpdir(), 'contextflow-codex-installed-'));
    let requests = 0;
    const provider = createServer((request, response) => {
      requests++; request.resume();
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, undefined, 'the fixture must not inherit a personal API credential');
      if (fixture.status) {
        response.writeHead(fixture.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: fixture.error })); return;
      }
      const message = { id: 'fixture-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: fixture.text || '', annotations: [] }] };
      const result = { id: 'fixture-response', object: 'response', status: 'completed', output: fixture.empty ? [] : [message],
        usage: { input_tokens: 1, output_tokens: fixture.empty ? 0 : 1, total_tokens: fixture.empty ? 1 : 2 } };
      const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        ...fixture.empty ? [] : [
          { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: fixture.text },
          { type: 'response.output_item.done', output_index: 0, item: message },
        ], { type: 'response.completed', response: result }];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const runtime = createCodexRuntime({ rpcTimeoutMs: 5000, interruptMs: 200 });
    try {
      await writeFile(join(home, 'config.toml'), `model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local test fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`, { mode: 0o600 });
      const env = agentEnvironment(process.env, { HOME: home, CODEX_HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
      const run = options => runtime.run({ ...options, timeoutMs: 8000 });
      const prepared = { id: 'codex', label: 'Codex CLI', version, path: binary, env };
      if (fixture.code) await assert.rejects(() => testAgentConnection(prepared, { run }), error => {
        assert.equal(error.code, fixture.code); assert.match(error.message, fixture.hint);
        assert.doesNotMatch(error.message + JSON.stringify(error), /sk_PRIVATE|Bearer|Authorization|fixture-model/);
        return true;
      });
      else assert.equal((await testAgentConnection(prepared, { run })).ok, true);
      assert.equal(requests, 1, 'a completed or failed turn must not be replayed or switched to another model');
    } finally {
      await runtime.close(); await new Promise(resolve => provider.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
});
