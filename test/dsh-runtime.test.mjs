import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDshRuntime } from '../server/dsh-runtime.mjs';

// Exercise the real adapter with HTTP Response bodies and WebSocket messages,
// without loading user profiles, starting a browser, or calling a model.
function fixture({ handler, version = '0.1.0-rc.6', idleMs = 1000, timeoutMs = 1000,
  ignoreTerm = false, maxSessions = 32, onSpawn, connectFailure = false } = {}) {
  const modern = version === '0.2.1-rc.2';
  const children = [], requests = [], sockets = [], versions = [];
  const options = { bin: modern ? '/fixture/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' : '/fixture/dsh', env: {}, profile: 'full', contextKey: 'article-A',
    prompt: 'full history', continuationPrompt: 'next question', timeoutMs,
    contextState: { fresh: { loadedChunks: 1, turns: 1 }, resumed: { loadedChunks: 2, turns: 2 } } };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
  const spawnProcess = (bin, argv, spawnOptions) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, argv, bin, spawnOptions, kills: [],
      port: 20000 + children.length, sequence: 0, turn: 0, streamRevision: 0 });
    child.kill = signal => {
      child.kills.push(signal);
      if (ignoreTerm && signal === 'SIGTERM') return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.signalCode = signal;
      setImmediate(() => child.emit('close', null, signal));
    };
    children.push(child);
    setImmediate(() => {
      onSpawn?.(child);
      if (modern) child.emit('message', { type: 'ready', profile: 'desktop', backgroundScheduling: false, url: `http://127.0.0.1:${child.port}/?token=fixture_owned_token` });
      else child.stdout.write(`dsh web: http://127.0.0.1:${child.port}\n`);
    });
    return child;
  };
  const createSocket = (url, socketOptions) => {
    if (modern) assert.equal(socketOptions.headers.Cookie, 'dsh-fixture=v2.fixture.signature');
    const socket = new EventTarget();
    socket.url = url; socket.open = false; socket.closed = false;
    socket.send = text => {
      assert.ok(modern, 'legacy feeds remain downlink-only');
      const message = JSON.parse(text);
      if (message.type !== 'open') return;
      assert.equal(message.endpoint, 'session/follow');
      socket.streamId = message.streamId; socket.sessionId = message.payload.args.request.address.sessionId;
      const child = children.find(c => String(c.port) === new URL(url).port);
      setImmediate(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: socket.streamId, value: {
        type: 'snapshot', header: { id: socket.sessionId }, cursor: child.sequence, assistantStream: { revision: child.streamRevision },
      } }) })));
    };
    socket.close = () => {
      socket.closed = true;
      setImmediate(() => socket.dispatchEvent(new Event('close')));
    };
    sockets.push(socket);
    setImmediate(() => { socket.open = true; socket.dispatchEvent(new Event('open')); });
    return socket;
  };
  const publish = (child, payload, rpcId = `event-${++child.sequence}`, kind = 'mux') => {
    for (const socket of sockets) if (socket.open && !socket.closed && new URL(socket.url).port === String(child.port)) {
      if (modern) {
        if (socket.sessionId !== payload.sessionId) continue;
        const deliver = value => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: socket.streamId, value }) }));
        if (payload.type === 'session/event' && payload.event.type === 'assistant/chunk') {
          const data = payload.event.data;
          if (child.attemptTurn !== data.turn || child.attemptStep !== data.step) {
            child.attemptTurn = data.turn; child.attemptStep = data.step; child.frameIndex = 0;
            child.attemptId = `attempt-${data.turn}-${data.step}`;
            deliver({ type: 'assistant-stream', frame: { type: 'start', attemptId: child.attemptId, revision: ++child.streamRevision, turn: data.turn, step: data.step } });
          }
          deliver({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: child.attemptId, revision: ++child.streamRevision,
            index: child.frameIndex++, chunk: data.chunk } });
        } else if (payload.type === 'session/event') deliver({ type: 'event', event: payload.event });
      } else if (socket.url.endsWith(`events.${kind}`)) {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload }) }));
      }
    }
  };
  const fetcher = async (url, init) => {
    if (modern && init.method === 'GET') {
      assert.equal(new URL(url).searchParams.get('interactions'), 'none');
      assert.equal(new URL(url).searchParams.get('token'), 'fixture_owned_token');
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: connectFailure ? 401 : 302, headers: { location: './api/remote.mux', 'set-cookie': 'dsh-fixture=v2.fixture.signature; HttpOnly' } });
    }
    const wire = JSON.parse(init.body);
    if (modern) assert.equal(init.headers.Cookie, 'dsh-fixture=v2.fixture.signature');
    const message = modern ? { ...wire, method: wire.method.replace('/', '.'), payload: wire.payload.args.request } : wire;
    const child = children.find(c => String(c.port) === new URL(url).port);
    requests.push({ ...message, url, signal: init.signal });
    assert.equal(init.redirect, 'error');
    assert.ok(sockets.filter(s => new URL(s.url).port === String(child.port)).every(s => s.open));
    const reply = value => response({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } });
    const event = (sessionId, type, data, seq) => publish(child, { type: 'session/event', sessionId,
      event: { seq: seq ?? ++child.sequence, type, time: Date.now(), data } });
    const overridden = handler?.({ message, child, reply, response, signal: init.signal,
      publish: (p, id, kind) => publish(child, p, id, kind), event });
    if (overridden !== undefined) return overridden;
    if (url.endsWith('/api/respond')) return response({ accepted: true });
    if (message.method === 'session.create') return reply({ sessionId: message.payload.sessionId });
    if (message.method === 'session.prompt') {
      if (modern) assert.equal(message.payload.requestId, message.rpcId);
      const sessionId = message.payload.sessionId, turn = ++child.turn;
      event(sessionId, 'turn/start', { turn });
      event(sessionId, 'user/message', { role: 'user', source: { kind: 'user', rpcId: message.rpcId }, content: message.payload.content });
      event(sessionId, 'assistant/chunk', { turn, step: 1, chunk: { type: 'reasoning-delta', text: 'private reasoning' } });
      event(sessionId, 'assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: '中文' } });
      event(sessionId, 'assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: '答案' } });
      event(sessionId, 'assistant/chunk', { turn, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 8 } } });
      event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: '中文答案' }] },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 8 } });
      event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
      return reply({ accepted: true });
    }
    return reply({ accepted: true });
  };
  const runtime = createDshRuntime({ spawnProcess, fetcher, createSocket,
    checkVersion: async id => { versions.push(id); return version; },
    idleMs, rpcTimeoutMs: 150, startupMs: 200, interruptMs: 20, maxSessions });
  return { runtime, options, children, requests, sockets, versions, publish };
}
const calls = (f, method) => f.requests.filter(r => r.method === method);
let pass = 0;
const test = async (name, run) => {
  try { await run(); pass++; console.log(`  ok   ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`  FAIL ${name}\n${error.stack}`); }
};

await test('one process and article session are reused with incremental text and truthful usage', async () => {
  const f = fixture();
  try {
    const events = [];
    const first = await f.runtime.run({ ...f.options, onEvent: event => events.push(event) });
    const cached = f.runtime.getSession(f.options);
    const second = await f.runtime.run({ ...f.options, expectedSessionId: cached.sessionId });
    assert.equal(f.children.length, 1); assert.equal(f.versions.length, 1);
    assert.deepEqual(f.children[0].argv, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0']);
    assert.equal(calls(f, 'session.create').length, 1);
    assert.deepEqual(calls(f, 'session.prompt').map(r => r.payload.content[0].text), ['full history', 'next question']);
    assert.equal(first.resumed, false); assert.equal(second.resumed, true);
    assert.equal(first.transport, 'dsh-web'); assert.equal(first.persistent, true);
    assert.equal(first.answer, '中文答案');
    assert.deepEqual(first.usage, { in: 18, out: 4, cacheRead: 8, cacheWrite: 0 });
    assert.deepEqual(events.filter(e => e.type === 'answer').map(e => e.text), ['中文', '中文答案', '中文答案']);
    assert.ok(!events.some(e => e.type === 'answer' && e.text.includes('private')));
    assert.ok(first.timings.totalMs >= first.timings.firstOutputMs);
    assert.equal(f.runtime.getSession(f.options).loadedChunks, 2);
  } finally { await f.runtime.close(); }
});

await test('article identities are separate; a stale lookup rebuilds the full prompt', async () => {
  const f = fixture();
  try {
    const first = await f.runtime.run(f.options);
    const other = await f.runtime.run({ ...f.options, contextKey: 'article-B' });
    const stale = await f.runtime.run({ ...f.options, expectedSessionId: 'stale' });
    assert.equal(f.children.length, 1); assert.notEqual(first.sessionId, other.sessionId);
    assert.equal(stale.resumed, false); assert.notEqual(stale.sessionId, first.sessionId);
    assert.equal(calls(f, 'session.prompt').at(-1).payload.content[0].text, 'full history');
  } finally { await f.runtime.close(); }
});

await test('DSH_HOME and explicit note directories isolate processes and sessions', async () => {
  const f = fixture();
  try {
    await f.runtime.run(f.options);
    await f.runtime.run({ ...f.options, env: { DSH_HOME: '/fixture/home-B' } });
    await f.runtime.run({ ...f.options, notesDir: '/fixture/notes' });
    assert.equal(f.children.length, 3);
    assert.equal(f.children[2].spawnOptions.cwd, '/fixture/notes');
    assert.notEqual(calls(f, 'session.create')[0].payload.sessionId, calls(f, 'session.create')[2].payload.sessionId);
  } finally { await f.runtime.close(); }
});

await test('first-boot profile files do not lose the cached process, while later edits invalidate it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cf-dsh-identity-'));
  const f = fixture({ onSpawn() {
    const profile = join(home, 'profiles/web'); mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), '{"version":"fixture"}');
  } });
  const options = { ...f.options, env: { DSH_HOME: home } };
  try {
    const first = await f.runtime.run(options);
    assert.equal(f.runtime.getSession(options)?.sessionId, first.sessionId);
    const second = await f.runtime.run({ ...options, expectedSessionId: first.sessionId });
    assert.equal(second.resumed, true); assert.equal(f.children.length, 1);
    writeFileSync(join(home, 'cordis.patch.yml'), '[]');
    assert.equal(f.runtime.getSession(options), null);
    const changed = await f.runtime.run({ ...options, expectedSessionId: first.sessionId });
    assert.equal(changed.resumed, false); assert.equal(f.children.length, 2);
  } finally { await f.runtime.close(); rmSync(home, { recursive: true, force: true }); }
});

await test('Safe and connection tests cannot start a Full runtime', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.runtime.run({ ...f.options, profile: 'safe' }), e => e.code === 'AGENT_SAFE_UNSUPPORTED');
    await assert.rejects(f.runtime.run({ ...f.options, connectionTest: true }), e => e.code === 'AGENT_TEST_SCOPE');
    assert.equal(f.children.length, 0); assert.equal(f.versions.length, 0);
  } finally { await f.runtime.close(); }
});

await test('unqualified versions fall back before starting Web or submitting any prompt', async () => {
  const f = fixture({ version: '0.0.0-unverified' });
  try {
    await assert.rejects(f.runtime.run(f.options), e => e.code === 'DSH_UNSUPPORTED' && e.submitted === false);
    assert.equal(f.children.length, 0); assert.equal(f.requests.length, 0);
  } finally { await f.runtime.close(); }
});

await test('only a successful terminal and matching HTTP receipt can commit an answer', async () => {
  const f = fixture({ handler({ message, reply, event }) {
    if (message.method !== 'session.prompt') return;
    const sessionId = message.payload.sessionId, turn = 1;
    event(sessionId, 'turn/start', { turn });
    event(sessionId, 'user/message', { source: { rpcId: message.rpcId } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'partial' }] } });
    event(sessionId, 'turn/end', { turn, reason: { kind: 'error', error: { message: 'model failed' } } });
    return reply({ accepted: true });
  } });
  try {
    await assert.rejects(f.runtime.run(f.options), e => e.code === 'AGENT_ERROR' && e.submitted === true);
    assert.equal(f.runtime.getSession(f.options), null);
    assert.equal(calls(f, 'session.prompt').length, 1);
  } finally { await f.runtime.close(); }
});

await test('an early successful event cannot mask a mismatched command response', async () => {
  const f = fixture({ handler({ message, response, event }) {
    if (message.method !== 'session.prompt') return;
    const sessionId = message.payload.sessionId, turn = 1;
    event(sessionId, 'turn/start', { turn });
    event(sessionId, 'user/message', { source: { rpcId: message.rpcId } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'uncommitted' }] } });
    event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    return response({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: { accepted: true } } });
  } });
  try {
    await assert.rejects(f.runtime.run(f.options), e => e.code === 'DSH_PROTOCOL' && e.submitted === true);
    assert.equal(f.runtime.getSession(f.options), null);
  } finally { await f.runtime.close(); }
});

await test('foreign sessions, stale turns, and duplicate sequence events never become the answer', async () => {
  const f = fixture({ handler({ message, reply, event }) {
    if (message.method !== 'session.prompt') return;
    const sessionId = message.payload.sessionId, turn = 3;
    event(sessionId, 'turn/start', { turn: 2 });
    event(sessionId, 'user/message', { source: { rpcId: 'old-rpc' } });
    event(sessionId, 'assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'old answer' }] } });
    event(sessionId, 'turn/start', { turn });
    event(sessionId, 'user/message', { source: { rpcId: message.rpcId } });
    event('foreign', 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'foreign' }] } });
    event(sessionId, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'stale' } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'current' }] } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'duplicate' }] } }, 1);
    event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    return reply({ accepted: true });
  } });
  try { assert.equal((await f.runtime.run(f.options)).answer, 'current'); }
  finally { await f.runtime.close(); }
});

await test('cancellation sends cancel, invalidates process state, and never replays', async () => {
  const ctl = new AbortController();
  const f = fixture({ handler({ message, reply }) {
    if (message.method !== 'session.prompt') return;
    setImmediate(() => ctl.abort()); return reply({ accepted: true });
  } });
  try {
    await assert.rejects(f.runtime.run({ ...f.options, signal: ctl.signal }), e => e.code === 'ABORTED');
    assert.equal(calls(f, 'session.cancel').length, 1);
    assert.equal(calls(f, 'session.prompt').length, 1);
    assert.equal(f.runtime.getSession(f.options), null);
    assert.equal(f.children[0].signalCode, 'SIGTERM');
    assert.ok(f.sockets.every(s => s.closed));
  } finally { await f.runtime.close(); }
});

await test('cancellation still interrupts when completion arrived before the delayed HTTP receipt', async () => {
  const ctl = new AbortController();
  const f = fixture({ handler({ message, signal, event }) {
    if (message.method !== 'session.prompt') return;
    const sessionId = message.payload.sessionId, turn = 1;
    event(sessionId, 'turn/start', { turn });
    event(sessionId, 'user/message', { source: { rpcId: message.rpcId } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'too early' }] } });
    event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    setImmediate(() => ctl.abort());
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  } });
  try {
    await assert.rejects(f.runtime.run({ ...f.options, signal: ctl.signal }), e => e.code === 'ABORTED');
    assert.equal(f.runtime.getSession(f.options), null);
    assert.equal(calls(f, 'session.cancel').length, 1);
  } finally { await f.runtime.close(); }
});

await test('shutdown aborts and waits for an in-flight version probe before any Web process starts', async () => {
  let started, reaped = false, spawned = false;
  const ready = new Promise(resolve => { started = resolve; });
  const runtime = createDshRuntime({
    spawnProcess() { spawned = true; throw new Error('must not start Web after shutdown'); },
    checkVersion(_id, signal) {
      started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        setTimeout(() => { reaped = true; reject(new DOMException('aborted', 'AbortError')); }, 5);
      }, { once: true }));
    },
  });
  const pending = runtime.run({ profile: 'full', prompt: 'test', bin: '/fixture/dsh', env: {} });
  const failed = assert.rejects(pending, e => e.code === 'DSH_DISCONNECTED' && e.submitted === false);
  await ready; await runtime.close(); await failed;
  assert.equal(reaped, true); assert.equal(spawned, false);
});

await test('timeout and event disconnection invalidate pending work without fallback', async () => {
  for (const disconnect of [false, true]) {
    const f = fixture({ timeoutMs: 30, handler({ message, reply, publish }) {
      if (message.method !== 'session.prompt') return;
      if (disconnect) setImmediate(() => f.sockets[0].dispatchEvent(new Event('close')));
      return reply({ accepted: true });
    } });
    try {
      await assert.rejects(f.runtime.run(f.options), e => e.code === (disconnect ? 'DSH_DISCONNECTED' : 'AGENT_TIMEOUT') && e.submitted === true);
      assert.equal(f.runtime.servers.size, 0);
      assert.equal(calls(f, 'session.prompt').length, 1);
    } finally { await f.runtime.close(); }
  }
});

await test('permissions and questions are declined only for sessions owned by this runtime', async () => {
  const f = fixture({ handler({ message, reply, publish, event }) {
    if (message.method !== 'session.prompt') return;
    const sessionId = message.payload.sessionId, turn = 1;
    publish({ type: 'approval/requested', sessionId: 'user-session', approvalId: 'outside' }, 'outside-rpc');
    publish({ type: 'approval/requested', sessionId, approvalId: 'own' }, 'own-rpc');
    publish({ type: 'question/requested', sessionId, questions: [] }, 'question-rpc');
    event(sessionId, 'turn/start', { turn });
    event(sessionId, 'user/message', { source: { rpcId: message.rpcId } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'done' }] } });
    event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    return reply({ accepted: true });
  } });
  try {
    await f.runtime.run(f.options);
    const replies = f.requests.filter(r => r.type === 'client-response');
    assert.equal(replies.length, 2);
    assert.equal(replies[0].rpcId, 'own-rpc');
    assert.equal(replies[0].result.value.outcome, 'rejected');
    assert.equal(replies[1].result.error.code, 'cancelled');
  } finally { await f.runtime.close(); }
});

await test('authentication failures are not eligible for compatibility fallback', async () => {
  const f = fixture({ handler({ message, response }) {
    if (message.method === 'session.create') return response({ error: 'private credentials must not be echoed' }, 401);
  } });
  try {
    await assert.rejects(f.runtime.run(f.options), e => e.code === 'AGENT_AUTH' && e.submitted === false && !e.message.includes('private'));
    assert.equal(calls(f, 'session.prompt').length, 0);
  } finally { await f.runtime.close(); }
});

await test('idle expiry and session cap rebuild rather than resuming an unavailable session', async () => {
  const f = fixture({ idleMs: 15, maxSessions: 1 });
  try {
    const first = await f.runtime.run(f.options);
    await new Promise(resolve => setTimeout(resolve, 30));
    const afterIdle = await f.runtime.run({ ...f.options, expectedSessionId: first.sessionId });
    assert.equal(afterIdle.resumed, false);
    await f.runtime.run({ ...f.options, contextKey: 'other' });
    assert.equal(f.children.length, 3);
  } finally { await f.runtime.close(); }
});

await test('concurrent submissions serialize and shutdown waits for SIGKILL escalation', async () => {
  const f = fixture({ ignoreTerm: true });
  const results = await Promise.all([f.runtime.run(f.options), f.runtime.run({ ...f.options, contextKey: 'B' })]);
  assert.equal(f.children.length, 1); assert.notEqual(results[0].sessionId, results[1].sessionId);
  // An invalidated server is absent from the reusable pool but still needs reaping.
  for (const server of f.runtime.servers.values()) server.destroy();
  assert.equal(f.runtime.servers.size, 0);
  await f.runtime.close();
  assert.deepEqual(f.children[0].kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(f.runtime.run(f.options), e => e.code === 'DSH_DISCONNECTED');
});

await test('desktop Host uses its bundled runtime and profile, private IPC, API authentication, and reusable streams', async () => {
  const f = fixture({ version: '0.2.1-rc.2' });
  try {
    const events = [], first = await f.runtime.run({ ...f.options, onEvent: e => events.push(e) });
    const second = await f.runtime.run({ ...f.options, expectedSessionId: first.sessionId });
    assert.equal(first.transport, 'dsh-desktop'); assert.equal(first.persistent, false); assert.equal(second.resumed, true);
    assert.ok(existsSync(f.children[0].spawnOptions.env.CONTEXTFLOW_DSH_STATE_DIR));
    assert.equal(first.sessionId, second.sessionId); assert.equal(f.children.length, 1);
    assert.equal(f.children[0].bin, '/fixture/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
    assert.ok(f.children[0].argv[1].endsWith('/server/dsh-desktop-host.mjs'));
    assert.ok(f.children[0].argv[3].endsWith('/profiles/desktop'));
    assert.deepEqual(f.children[0].spawnOptions.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
    assert.equal(f.children[0].spawnOptions.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(f.sockets.length, 1); assert.ok(f.sockets[0].url.endsWith('/api/remote.mux'));
    assert.deepEqual(calls(f, 'session.prompt').map(r => r.payload.content[0].text), ['full history', 'next question']);
    assert.ok(events.some(e => e.type === 'answer' && e.text === '中文'));
    assert.equal(first.answer, '中文答案'); assert.deepEqual(first.usage, { in: 18, out: 4, cacheRead: 8, cacheWrite: 0 });
  } finally { await f.runtime.close(); }
  assert.ok(!existsSync(f.children[0].spawnOptions.env.CONTEXTFLOW_DSH_STATE_DIR));
});

await test('desktop API authentication failure cannot submit a prompt or fall back', async () => {
  const f = fixture({ version: '0.2.1-rc.2', connectFailure: true });
  try {
    await assert.rejects(f.runtime.run(f.options), e => e.code === 'AGENT_AUTH' && e.submitted === false);
    assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0); assert.equal(f.runtime.getSession(f.options), null);
  } finally { await f.runtime.close(); }
});

await test('desktop cancellation calls its session API then closes only its owned process', async () => {
  const f = fixture({ version: '0.2.1-rc.2', handler({ message, reply }) {
    if (message.method === 'session.prompt') return reply({ accepted: true });
  } });
  try {
    const controller = new AbortController();
    const pending = f.runtime.run({ ...f.options, signal: controller.signal });
    while (!calls(f, 'session.prompt').length) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, e => e.code === 'ABORTED' && e.submitted === true);
    assert.equal(calls(f, 'session.cancel').length, 1); assert.equal(calls(f, 'session.prompt').length, 1);
    assert.ok(f.children[0].kills.includes('SIGTERM')); assert.equal(f.runtime.getSession(f.options), null);
  } finally { await f.runtime.close(); }
});

await test('desktop retry attempts replace failed partial text within the same model step', async () => {
  let f;
  f = fixture({ version: '0.2.1-rc.2', handler({ message, child, reply, event }) {
    if (message.method !== 'session.prompt') return;
    const sessionId = message.payload.sessionId, turn = ++child.turn;
    event(sessionId, 'turn/start', { turn });
    event(sessionId, 'user/message', { source: { kind: 'user', rpcId: message.rpcId } });
    const frame = value => {
      const socket = f.sockets[0];
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: socket.streamId,
        value: { type: 'assistant-stream', frame: { ...value, revision: ++child.streamRevision } } }) }));
    };
    frame({ type: 'start', turn, step: 1, attemptId: 'failed-attempt' });
    frame({ type: 'chunk', attemptId: 'failed-attempt', index: 0, chunk: { type: 'text-delta', index: 0, text: '失败残片' } });
    frame({ type: 'end', attemptId: 'failed-attempt', outcome: 'aborted' });
    frame({ type: 'start', turn, step: 1, attemptId: 'good-attempt' });
    frame({ type: 'chunk', attemptId: 'good-attempt', index: 0, chunk: { type: 'text-delta', index: 0, text: '正确答案' } });
    event(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: '正确答案' }] } });
    event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    return reply({ accepted: true });
  } });
  try {
    const events = [], result = await f.runtime.run({ ...f.options, onEvent: e => events.push(e) });
    assert.equal(result.answer, '正确答案');
    assert.deepEqual(events.filter(e => e.type === 'answer').map(e => e.text), ['失败残片', '正确答案', '正确答案']);
  } finally { await f.runtime.close(); }
});

console.log(`\n${pass} DSH runtime checks passed`);
