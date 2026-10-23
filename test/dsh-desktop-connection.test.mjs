import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createDshRuntime } from '../server/dsh-runtime.mjs';
import { CONNECTION_PROMPT, testAgentConnection } from '../server/agent-test.mjs';

// Opt-in real Desktop validation. All provider calls go to this local mock;
// Electron is explicitly preloaded with a guard, since it ignores NODE_OPTIONS.
const bin = process.env.CONTEXTFLOW_DSH_BIN || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const resources = resolve(dirname(await realpath(bin)), '../../..');
const electron = resolve(resources, '../MacOS/DeepSeek Harness');
const root = await mkdtemp(join(tmpdir(), 'cf-dsh-connection-'));
const home = join(root, 'home'), dshHome = join(root, 'dsh');
await mkdir(home); await mkdir(dshHome);
const children = [], calls = [], errors = [], stateDirectories = [], messages = [];
const startupSentinel = join(root, 'untrusted-plugin-started');
const toolSentinel = join(root, 'untrusted-tool-wrote');
const guardMarker = join(root, 'guard-loaded');
const fixtureGrant = 'isolated-fixture-account-grant';
let runtime, mode = 'full', childErr = '', cancelController, canceledAfterPartial = false, modelListings = 0;
const mock = createServer((req, res) => { void (async () => {
  if (req.method === 'GET' && req.url === '/models') {
    modelListings++;
    assert.equal(req.headers['x-dsh-auth-token'], fixtureGrant);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', api_capabilities: { anthropic_messages: {} } }] }));
    return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls.push({ mode, body });
  assert.equal(req.url, '/v1/messages');
  if (mode === 'account') assert.equal(req.headers['x-dsh-auth-token'], fixtureGrant);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  send({ type: 'message_start', message: { id: 'isolated-connection-fixture', type: 'message', role: 'assistant',
    model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } });
  if (mode === 'tool') {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'malicious-write', name: 'write', input: {} } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta',
      partial_json: JSON.stringify({ file_path: toolSentinel, content: 'This tool must never execute' }) } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } });
    send({ type: 'message_stop' });
    res.end(); return;
  }
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: mode === 'cancel' ? 'partial' : 'OK' } });
  if (mode === 'cancel') {
    setImmediate(() => { canceledAfterPartial = true; cancelController.abort(); });
    return; // Remain open until cancellation tears down the request.
  }
  if (mode === 'timeout') return;
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
  send({ type: 'message_stop' });
  res.end();
})().catch(error => { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end('isolated fixture failed'); }); });

try {
  await new Promise(resolveListen => mock.listen(0, '127.0.0.1', resolveListen));
  const provider = `http://127.0.0.1:${mock.address().port}`;
  const guard = join(root, 'network-guard.mjs');
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
  const supplied = Array.isArray(args[0]) ? args[0] : args, first = supplied[0];
  const pipe = first && typeof first === 'object' && typeof first.path === 'string';
  const host = first && typeof first === 'object' ? (first.host || first.hostname || 'localhost')
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
  const profilePackage = { name: 'dsh-profile-desktop', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
  await writeFile(join(desktopProfile, 'package.json'), JSON.stringify(profilePackage));
  const patch = join(desktopProfile, 'cordis.patch.yml');
  await writeFile(patch, `- id: llm-deepseek\n  config:\n    apiKeyEnv: CF_LOCAL_FIXTURE_KEY\n    baseURL: ${provider}\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: 128\n    streamIdleTimeoutMs: 5000\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n- id: session-title-llm\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- id: llm-retry\n  disabled: true\n- id: deepseek-account\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n`);
  await writeFile(join(root, 'AGENTS.md'), 'PROJECT_INSTRUCTIONS_MUST_NOT_ENTER_CONNECTION_TEST');
  runtime = createDshRuntime({ spawnProcess: (command, args, options) => {
    assert.equal(command, electron);
    if (options.env.CONTEXTFLOW_DSH_STATE_DIR) stateDirectories.push(options.env.CONTEXTFLOW_DSH_STATE_DIR);
    const child = spawn(command, ['--import', guard, ...args], options);
    children.push(child);
    child.stderr.on('data', chunk => { childErr = (childErr + chunk).slice(-4000); });
    child.on('message', message => {
      // Store only fixed non-secret metadata, never token-bearing readiness URLs.
      messages.push({ type: message?.type, scope: message?.scope, toolsDisabled: message?.toolsDisabled });
    });
    return child;
  } });
  const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: dshHome, LANG: 'en_US.UTF-8', TMPDIR: tmpdir(),
    USER: 'contextflow-fixture', CF_LOCAL_FIXTURE_KEY: 'fixture-not-a-real-key' };
  const fullOptions = { bin, env, notesDir: root, profile: 'full', contextKey: 'same-article',
    prompt: 'FULL_READING_HISTORY_MUST_NOT_ENTER_CONNECTION_TEST', timeoutMs: 15000,
    contextState: { fresh: { loadedChunks: 1, turns: 1 } } };
  const full = await runtime.run(fullOptions);
  assert.equal(full.answer, 'OK');
  const fullChild = children[0], fullSession = runtime.getSession(fullOptions);
  assert.ok(fullSession);
  const prepared = { id: 'dsh', label: 'DeepSeek Harness', version: '0.2.1-rc.2', path: bin, env };
  const probeRun = options => runtime.run({ ...options, bin, env });
  mode = 'ok';
  for (let index = 0; index < 2; index++) {
    const result = await testAgentConnection(prepared, { run: probeRun });
    assert.equal(result.ok, true);
    assert.equal(result.scope, 'connection-only');
    assert.equal(result.profile, 'safe');
    assert.equal(result.agent, 'dsh');
    assert.ok(!JSON.stringify(result).includes('sessionId'));
    assert.ok(!JSON.stringify(result).includes('fixture-not-a-real-key'));
    assert.deepEqual(runtime.getSession(fullOptions), fullSession, 'probing must keep Full context intact');
    assert.equal(runtime.servers.size, 1, 'a connection test must not join the Full worker pool');
  }
  assert.equal(children.length, 3, 'each probe starts a separate short-lived process');
  assert.equal(fullChild.exitCode, null);
  assert.equal(fullChild.signalCode, null);
  assert.ok(children.slice(1).every(child => child.exitCode !== null || child.signalCode !== null), 'finished probes must be reaped');
  for (const { body } of calls.filter(call => call.mode !== 'full')) {
    assert.equal(body.model, 'deepseek-flash', 'probing must use the configured Desktop model');
    assert.ok(!body.tools?.length, 'a connection test must send no tool definitions');
    const serialized = JSON.stringify(body);
    assert.ok(serialized.includes('Reply with exactly OK'));
    assert.ok(!serialized.includes('FULL_READING_HISTORY_MUST_NOT_ENTER_CONNECTION_TEST'));
    assert.ok(!serialized.includes('PROJECT_INSTRUCTIONS_MUST_NOT_ENTER_CONNECTION_TEST'));
  }
  // End the Full worker before changing its profile fixture: its normal HMR is
  // allowed to reload user plugins, whereas the connection probe is not.
  await [...runtime.servers.values()][0].destroy();

  // Untrusted profile extensions may contain import-time code. A probe must read
  // only permitted model settings, without booting these bundles or plugins.
  const evil = join(desktopProfile, 'node_modules/evil-connection-fixture');
  await mkdir(evil, { recursive: true });
  await writeFile(join(evil, 'package.json'), JSON.stringify({ name: 'evil-connection-fixture', type: 'module',
    exports: { '.': './index.js', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(evil, 'index.js'), `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(startupSentinel)}, 'unsafe plugin loaded');\nexport default () => {};\n`);
  await writeFile(join(evil, 'cordis.patch.yml'), "- insert:\n    - id: evil-connection-fixture\n      name: evil-connection-fixture\n");
  profilePackage.dsh.profile.bundles.push('evil-connection-fixture');
  await writeFile(join(desktopProfile, 'package.json'), JSON.stringify(profilePackage));
  const beforeUnsupported = calls.length;
  await assert.rejects(testAgentConnection(prepared, { run: probeRun }), error => error.code === 'DSH_PROBE_UNSUPPORTED');
  assert.equal(calls.length, beforeUnsupported, 'an unsupported custom bundle must not test a different model silently');
  await assert.rejects(access(startupSentinel), error => error.code === 'ENOENT');
  profilePackage.dsh.profile.bundles.pop();
  await writeFile(join(desktopProfile, 'package.json'), JSON.stringify(profilePackage));
  await writeFile(patch, (await readFile(patch, 'utf8')) + '\n- insert:\n    - id: evil-connection-fixture\n      name: evil-connection-fixture\n');
  const originalPatch = await readFile(patch, 'utf8');
  mode = 'tool';
  const beforeTool = calls.length;
  await assert.rejects(testAgentConnection(prepared, { run: probeRun }), error => error.code === 'AGENT_TEST_TOOLS_FORBIDDEN');
  assert.equal(calls.length, beforeTool + 1, 'a tool response must not begin a second model step');
  assert.ok(!calls.at(-1).body.tools?.length);
  await assert.rejects(access(toolSentinel), error => error.code === 'ENOENT');
  await assert.rejects(access(startupSentinel), error => error.code === 'ENOENT');

  mode = 'cancel';
  cancelController = new AbortController();
  const beforeCancel = calls.length;
  await assert.rejects(runtime.run({ bin, env, profile: 'safe', connectionTest: true,
    prompt: CONNECTION_PROMPT, notesDir: '', timeoutMs: 15000, signal: cancelController.signal,
  }), error => error.code === 'ABORTED');
  assert.ok(canceledAfterPartial);
  assert.equal(calls.length, beforeCancel + 1, 'cancellation must not replay a probe');
  mode = 'timeout';
  const beforeTimeout = calls.length;
  await assert.rejects(runtime.run({ bin, env, profile: 'safe', connectionTest: true,
    prompt: CONNECTION_PROMPT, notesDir: '', timeoutMs: 2500,
  }), error => error.code === 'AGENT_TIMEOUT');
  assert.equal(calls.length, beforeTimeout + 1, 'the real provider must be reached before testing timeout');
  assert.equal(await readFile(patch, 'utf8'), originalPatch, 'testing must not edit model configuration');

  const accountPatch = `- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n- id: deepseek-account\n  config:\n    platformOrigin: ${provider}\n    inferenceOrigin: ${provider}\n    allowLoopbackHttp: true\n- id: llm-deepseek-account\n  config:\n    baseURL: ${provider}\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: 128\n    modelsTimeoutMs: 3000\n`;
  await writeFile(patch, accountPatch);
  mode = 'account';
  const beforeAccount = calls.length, beforeListings = modelListings;
  await assert.rejects(testAgentConnection(prepared, { run: probeRun }), error => error.code === 'AGENT_AUTH');
  assert.equal(calls.length, beforeAccount, 'missing account grants must fail before inference');
  assert.equal(modelListings, beforeListings, 'missing account grants must not send a model listing request');
  const credentialPath = join(dshHome, '.credentials.yaml');
  const credentialFixture = JSON.stringify({ version: 1, records: { 'deepseek-account-platform/default': {
    kind: 'grant', payload: { version: 1, token: fixtureGrant, issuer: provider },
  } } });
  await writeFile(credentialPath, credentialFixture, { mode: 0o600 });
  const accountResult = await testAgentConnection(prepared, { run: probeRun });
  assert.equal(accountResult.ok, true);
  assert.equal(accountResult.scope, 'connection-only');
  assert.equal(modelListings, beforeListings + 1, 'account probing must use the credential-scoped model catalog');
  assert.equal(calls.length, beforeAccount + 1);
  assert.ok(!calls.at(-1).body.tools?.length);
  assert.equal(await readFile(credentialPath, 'utf8'), credentialFixture, 'testing must not edit account grants');
  assert.equal(await readFile(patch, 'utf8'), accountPatch, 'testing must not edit account model configuration');
  assert.deepEqual(errors, []);
  assert.ok(!childErr.includes('OUTBOUND_'), 'a child attempted an external request');
  await runtime.close();
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  const attestedProbes = messages.filter(message => message.type === 'ready' && message.scope === 'connection-only');
  // Unsupported bundles fail before readiness. Missing grants may fail after
  // readiness but before inference; every inference still needs an attestation.
  assert.ok(attestedProbes.length >= calls.length - 1, 'each inference probe must attest its fixed, tool-free scope');
  assert.ok(attestedProbes.every(message => message.toolsDisabled === true));
  const guardedPids = (await readFile(guardMarker, 'utf8')).trim().split('\n').map(Number);
  assert.deepEqual(guardedPids, children.map(child => child.pid));
  for (const directory of stateDirectories) await assert.rejects(access(directory), error => error.code === 'ENOENT');
  console.log(JSON.stringify({ result: 'PASS', realVersion: '0.2.1-rc.2', realProcesses: children.length,
    isolatedConnectionTests: true, emptyTools: true, toolExecutionRejected: true, untrustedPluginNotLoaded: true,
    fullSessionUnchanged: true, canceledAfterPartial, timeoutRejected: true,
    missingAccountGrantRejected: true, accountProviderPassed: true, processesClosed: true, realModelCalls: 0 }));
} catch (error) {
  if (childErr) console.error(childErr);
  throw error;
} finally {
  await runtime?.close();
  mock.closeAllConnections(); await new Promise(resolveClose => mock.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
