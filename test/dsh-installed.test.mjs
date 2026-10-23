import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshRuntime } from '../server/dsh-runtime.mjs';

// Real rc.6 protocol, fake provider only. All child fetches and TCP connections
// are restricted to 127.0.0.1 by a preload, and no personal configuration is used.
// Opt in with npm run test:dsh:legacy:installed; CONTEXTFLOW_DSH_BIN overrides PATH.
const bin = process.env.CONTEXTFLOW_DSH_BIN || 'dsh';
const root = await mkdtemp(join(tmpdir(), 'cf-dsh-real-mock-'));
const home = join(root, 'home'), dshHome = join(root, 'dsh');
await mkdir(home); await mkdir(dshHome);
let runtime, requests = 0, childErr = '';
const children = [];
const bodies = [];
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests++; bodies.push(JSON.parse(raw));
  assert.equal(req.url, '/chat/completions');
  if (requests === 3) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'isolated fixture authentication failure', type: 'authentication_error', code: 'invalid_api_key' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const frame = (delta, finish_reason = null) => ({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1,
    model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason }] });
  send(frame({ role: 'assistant', content: '' }));
  send(frame({ content: '隔离' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  send(frame({ content: '流式答案' }));
  send({ ...frame({}, 'stop'), usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_cache_hit_tokens: 4 } });
  res.end('data: [DONE]\n\n');
});

try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const provider = `http://127.0.0.1:${mock.address().port}`;
  const guard = join(root, 'local-network-only.mjs');
  await writeFile(guard, `import net from 'node:net';\nimport tls from 'node:tls';\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = (input, ...args) => {\n  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);\n  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('OUTBOUND_NETWORK_BLOCKED');\n  return originalFetch(input, ...args);\n};\nconst originalConnect = net.Socket.prototype.connect;\nnet.Socket.prototype.connect = function(...args) {\n  const first = args[0];\n  const host = first && typeof first === 'object' ? (first.host || first.hostname || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');\n  if (!(first && typeof first === 'object' && first.path) && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw Error('OUTBOUND_TCP_BLOCKED');\n  return originalConnect.apply(this, args);\n};\ntls.connect = () => { throw Error('OUTBOUND_TLS_BLOCKED'); };\n`);
  const patch = join(dshHome, 'cordis.patch.yml');
  await writeFile(patch, `- id: llm-deepseek\n  config:\n    apiKeyEnv: CF_LOCAL_FIXTURE_KEY\n    baseURL: ${provider}\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: 128\n    streamIdleTimeoutMs: 5000\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n- id: session-title-llm\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- id: llm-retry\n  disabled: true\n`);
  runtime = createDshRuntime({ spawnProcess: (...args) => {
    const child = spawn(...args); children.push(child);
    child.stderr.on('data', chunk => { childErr = (childErr + chunk).slice(-4000); });
    return child;
  } });
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(),
    USER: 'contextflow-fixture', CF_LOCAL_FIXTURE_KEY: 'fixture-not-a-real-key', NODE_OPTIONS: `--import=${guard}` };
  const events = [];
  const options = { bin, env, notesDir: root, profile: 'full', timeoutMs: 15000,
    contextKey: 'article-fixture', prompt: '固定测试问题一，直接回答，不调用工具。',
    continuationPrompt: '固定测试问题二，请承接前文，直接回答，不调用工具。',
    contextState: { fresh: { loadedChunks: 1, turns: 1 }, resumed: { loadedChunks: 1, turns: 2 } },
    onEvent: event => events.push(event),
  };
  const first = await runtime.run(options);
  assert.equal(first.answer, '隔离流式答案');
  assert.equal(first.resumed, false);
  assert.ok(events.some(event => event.type === 'answer' && event.text === '隔离'));
  const cached = runtime.getSession(options);
  assert.ok(cached, 'fresh DSH_HOME bootstrap must not change the runtime identity');
  const second = await runtime.run({ ...options, expectedSessionId: cached.sessionId });
  assert.equal(second.answer, '隔离流式答案');
  assert.equal(second.resumed, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(children.length, 1, 'same article must keep the same real DSH process');
  assert.equal(bodies[1].messages.some(message => JSON.stringify(message.content).includes('隔离流式答案')), true);
  const next = runtime.getSession(options);
  await assert.rejects(runtime.run({ ...options, expectedSessionId: next.sessionId,
    continuationPrompt: '固定测试问题三，预期本地模拟401。' }), error => /fixture authentication failure|DSH.*认证/.test(error.message));
  assert.equal(runtime.getSession(options), null);
  assert.equal(requests, 3, 'title/retry/tool calls must not send additional requests');
  assert.ok(!childErr.includes('OUTBOUND_'), 'child attempted an external request');
  await runtime.close();
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  console.log(JSON.stringify({ result: 'PASS', realVersion: '0.1.0-rc.6', realProcesses: children.length,
    resumed: second.resumed, sameSession: first.sessionId === second.sessionId, localModelRequests: requests,
    incrementalAnswer: events.some(event => event.type === 'answer' && event.text === '隔离'), usage: second.usage,
    errorRejected: true, processesClosed: true, realModelCalls: 0 }));
} catch (error) {
  if (childErr) console.error(childErr);
  throw error;
} finally {
  await runtime?.close();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await rm(root, { recursive: true, force: true });
}
