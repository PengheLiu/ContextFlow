import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDshRuntime } from '../server/dsh-runtime.mjs';

// Real Desktop 0.2.1-rc.2 protocol, fake provider only. All child fetches and TCP connections
// are restricted to 127.0.0.1 by a preload, and no personal configuration is used.
// Opt in with npm run test:dsh:installed; CONTEXTFLOW_DSH_BIN selects another
// installed macOS Desktop CLI entry. Electron ignores NODE_OPTIONS, so the
// network guard is passed explicitly to the real bundled Electron executable.
const bin = process.env.CONTEXTFLOW_DSH_BIN || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const resources = resolve(dirname(await realpath(bin)), '../../..');
const electron = resolve(resources, '../MacOS/DeepSeek Harness');
const root = await mkdtemp(join(tmpdir(), 'cf-dsh-desktop-mock-'));
const home = join(root, 'home'), dshHome = join(root, 'dsh');
await mkdir(home); await mkdir(dshHome);
let runtime, requests = 0, childErr = '';
const children = [];
const privateStateDirectories = [];
const readiness = [];
const bodies = [];
const mockErrors = [];
const mock = createServer((req, res) => { void (async () => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests++; bodies.push(JSON.parse(raw));
  assert.equal(req.url, '/v1/messages');
  if (requests === 3) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'isolated fixture authentication failure', type: 'authentication_error', code: 'invalid_api_key' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  send({ type: 'message_start', message: { id: 'fixture-completion', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null,
    usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } } });
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  if (requests === 4) {
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '未完成' } });
    return; // Hold the provider response open until ContextFlow cancels it.
  }
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '隔离' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '流式答案' } });
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  send({ type: 'message_stop' });
  res.end();
})().catch(error => {
  mockErrors.push(error);
  if (!res.headersSent) res.writeHead(500);
  res.end('isolated mock failed');
}); });

try {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const provider = `http://127.0.0.1:${mock.address().port}`;
  const guard = join(root, 'local-network-only.mjs');
  const guardMarker = join(root, 'guard-loaded');
  await writeFile(guard, `
import net from 'node:net';
import tls from 'node:tls';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('OUTBOUND_NETWORK_BLOCKED');
  return originalFetch(input, ...args);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const supplied = Array.isArray(args[0]) ? args[0] : args;
  const first = supplied[0];
  const pipe = first && typeof first === 'object' && typeof first.path === 'string';
  const host = first && typeof first === 'object'
    ? (first.host || first.hostname || 'localhost')
    : (typeof supplied[1] === 'string' ? supplied[1] : 'localhost');
  if (!pipe && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw Error('OUTBOUND_TCP_BLOCKED');
  return originalConnect.apply(this, args);
};
tls.connect = () => { throw Error('OUTBOUND_TLS_BLOCKED'); };
syncBuiltinESMExports();
appendFileSync(${JSON.stringify(guardMarker)}, String(process.pid) + '\\n');
`);
  const desktopProfile = join(dshHome, 'profiles/desktop');
  await mkdir(desktopProfile, { recursive: true });
  await writeFile(join(desktopProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }));
  const patch = join(desktopProfile, 'cordis.patch.yml');
  await writeFile(patch, `- id: llm-deepseek\n  config:\n    apiKeyEnv: CF_LOCAL_FIXTURE_KEY\n    baseURL: ${provider}\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: 128\n    streamIdleTimeoutMs: 5000\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n- id: session-title-llm\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- id: llm-retry\n  disabled: true\n`);
  await writeFile(patch, `${await readFile(patch, 'utf8')}- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n- id: deepseek-account\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n`);
  const originalProfilePatch = await readFile(patch, 'utf8');
  const sentinel = '.contextflow-existing-data';
  for (const name of ['sessions', 'storages']) {
    await mkdir(join(dshHome, name));
    await writeFile(join(dshHome, name, sentinel), 'existing Desktop data must stay unchanged');
  }
  runtime = createDshRuntime({ spawnProcess: (command, args, options) => {
    assert.equal(command, electron, 'the bundled Desktop Host must start, not the CLI Web profile');
    assert.ok(args.includes(fileURLToPath(new URL('../server/dsh-desktop-host.mjs', import.meta.url))));
    assert.ok(args.includes(desktopProfile));
    assert.ok(options.stdio.includes('ipc'), 'Desktop readiness must use its owned IPC channel');
    const privateState = options.env.CONTEXTFLOW_DSH_STATE_DIR;
    assert.equal(typeof privateState, 'string');
    assert.ok(!privateState.startsWith(dshHome), 'worker storage must be separate from Desktop storage');
    privateStateDirectories.push(privateState);
    const child = spawn(electron, ['--import', guard, ...args], {
      ...options, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    }); children.push(child);
    child.on('message', message => {
      if (message?.type === 'ready') readiness.push({ profile: message.profile, backgroundScheduling: message.backgroundScheduling });
    });
    child.stderr.on('data', chunk => { childErr = (childErr + chunk).slice(-4000); });
    return child;
  } });
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(),
    USER: 'contextflow-fixture', CF_LOCAL_FIXTURE_KEY: 'fixture-not-a-real-key' };
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
  assert.equal(first.persistent, false, 'ContextFlow Desktop sessions must stay in private temporary storage');
  assert.ok(events.some(event => event.type === 'answer' && event.text === '隔离'));
  assert.deepEqual(readiness, [{ profile: 'desktop', backgroundScheduling: false }]);
  assert.equal(bodies[0].max_tokens, 128, 'the owned worker must inherit Desktop profile model overrides');
  assert.ok(!bodies[0].tools.some(tool => tool.name.startsWith('schedule_')), 'the model must not receive scheduling tools');
  const ownedServer = [...runtime.servers.values()][0];
  await assert.rejects(ownedServer.rpc('schedule.list', { sessionId: first.sessionId }),
    error => error.code === 'DSH_RPC' && /404|not.found|unknown.*method|method.*not/i.test(`${error.rpcCode || ''} ${error.message}`),
    'the real worker must not mount the Host scheduling service');
  const privateFiles = await readdir(privateStateDirectories[0], { recursive: true });
  assert.ok(privateFiles.some(path => path.startsWith('sessions/')), 'session history must use private storage');
  assert.ok(privateFiles.some(path => path.startsWith('storage/')), 'workspace and projection data must use private storage');
  const cached = runtime.getSession(options);
  assert.ok(cached, 'fresh DSH_HOME bootstrap must not change the runtime identity');
  const second = await runtime.run({ ...options, expectedSessionId: cached.sessionId });
  assert.equal(second.answer, '隔离流式答案');
  assert.equal(second.resumed, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(second.usage, { in: 12, out: 5, cacheRead: 4, cacheWrite: 0 });
  assert.equal(children.length, 1, 'same article must keep the same real DSH process');
  assert.equal(bodies[1].messages.some(message => JSON.stringify(message.content).includes('隔离流式答案')), true);
  const next = runtime.getSession(options);
  await assert.rejects(runtime.run({ ...options, expectedSessionId: next.sessionId,
    continuationPrompt: '固定测试问题三，预期本地模拟401。' }), error => /fixture authentication failure|DSH.*认证/.test(error.message));
  assert.equal(runtime.getSession(options), null);
  assert.equal(requests, 3, 'title/retry/tool calls must not send additional requests');
  const controller = new AbortController();
  let partialSeen = false;
  await assert.rejects(runtime.run({ ...options, signal: controller.signal,
    prompt: '固定测试问题四，预期取消流式请求。',
    onEvent: event => {
      if (event.type === 'answer' && event.text === '未完成') { partialSeen = true; controller.abort(); }
    },
  }), error => error.code === 'ABORTED');
  assert.ok(partialSeen, 'the real Desktop provider must stream before cancellation');
  assert.equal(runtime.getSession(options), null);
  assert.equal(requests, 4, 'cancellation must not replay an accepted request');
  assert.equal(children.length, 2, 'an errored session must rebuild on a new owned process');
  assert.deepEqual(mockErrors, []);
  assert.ok(!childErr.includes('OUTBOUND_'), 'child attempted an external request');
  await runtime.close();
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  const guardedPids = (await readFile(guardMarker, 'utf8')).trim().split('\n').map(Number);
  assert.deepEqual(guardedPids, children.map(child => child.pid), 'every real Desktop process loaded the network guard');
  assert.equal(await readFile(patch, 'utf8'), originalProfilePatch, 'worker-only isolation must not edit the Desktop profile');
  assert.equal(new Set(privateStateDirectories).size, children.length, 'each owned process needs separate private storage');
  for (const directory of privateStateDirectories) await assert.rejects(access(directory), error => error.code === 'ENOENT');
  for (const name of ['sessions', 'storages']) {
    assert.deepEqual(await readdir(join(dshHome, name)), [sentinel], 'the worker must not add files to Desktop storage');
    assert.equal(await readFile(join(dshHome, name, sentinel), 'utf8'), 'existing Desktop data must stay unchanged');
  }
  console.log(JSON.stringify({ result: 'PASS', realVersion: '0.2.1-rc.2', realProcesses: children.length,
    resumed: second.resumed, sameSession: first.sessionId === second.sessionId, localModelRequests: requests,
    incrementalAnswer: events.some(event => event.type === 'answer' && event.text === '隔离'), usage: second.usage,
    errorRejected: true, canceledAfterPartial: partialSeen, processesClosed: true,
    networkGuardVerified: true, backgroundSchedulingDisabled: true, desktopProfileUnchanged: true,
    privateStorageCleaned: true, desktopStorageUnchanged: true, realModelCalls: 0 }));
} catch (error) {
  if (childErr) console.error(childErr);
  throw error;
} finally {
  await runtime?.close();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await rm(root, { recursive: true, force: true });
}
