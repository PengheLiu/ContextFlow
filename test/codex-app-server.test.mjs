import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRuntime } from '../server/codex-app-server.mjs';

// An in-memory app-server exercises the real JSONL transport, event ordering,
// lifecycle, and cancellation without launching a model or reading credentials.
function fixture({ handler, idleMs = 1000, rpcTimeoutMs = 200, maxThreads } = {}) {
  const children = [];
  const requests = [];
  const options = { env: {}, bin: '/fake/codex', contextKey: 'article-A', profile: 'safe',
    prompt: 'full context', continuationPrompt: 'next question',
    contextState: { fresh: { loadedChunks: 1, turns: 1 }, resumed: { loadedChunks: 2, turns: 2 } },
    timeoutMs: 1000 };
  const spawnProcess = (bin, argv, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.sent = [];
    child.bin = bin; child.argv = argv; child.spawnOptions = spawnOptions;
    const send = value => {
      if (!child.signalCode && child.exitCode == null) child.stdout.write(`${JSON.stringify(value)}\n`);
    };
    let input = '', threadNo = 0, turnNo = 0;
    child.stdin = new Writable({ write(chunk, _enc, next) {
      input += chunk;
      let pos;
      while ((pos = input.indexOf('\n')) >= 0) {
        const message = JSON.parse(input.slice(0, pos)); input = input.slice(pos + 1);
        child.sent.push(message); requests.push(message);
        setImmediate(() => {
          if (child.signalCode) return;
          if (handler?.({ message, send, child }) === true) return;
          if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-codex' } });
          if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: `p${children.indexOf(child)}-thread-${++threadNo}` } } });
          if (message.method === 'turn/start') {
            const threadId = message.params.threadId, turnId = `turn-${++turnNo}`;
            send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
            send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
            send({ method: 'item/started', params: { threadId, turnId, item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: '' } } });
            send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'comment', delta: 'PRIVATE PROGRESS' } });
            send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: '正在检查资料' } } });
            send({ method: 'item/started', params: { threadId, turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '' } } });
            send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'answer', delta: '中文' } });
            send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'answer', delta: '答案' } });
            send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { last: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 12, cacheWriteInputTokens: 0 } } } });
            send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
          }
          if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
        });
      }
      next();
    } });
    child.kill = signal => {
      if (child.signalCode) return;
      child.signalCode = signal;
      setImmediate(() => child.emit('close', null, signal));
    };
    children.push(child);
    return child;
  };
  const runtime = createCodexRuntime({ spawnProcess, idleMs, rpcTimeoutMs, interruptMs: 20, ...(maxThreads ? { maxThreads } : {}) });
  return { runtime, options, children, requests };
}

let pass = 0;
async function test(name, run) {
  try { await run(); pass++; console.log(`  ok   ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`  FAIL ${name}\n${error.stack}`); }
}
const methods = (f, name) => f.requests.filter(message => message.method === name);

await test('reuses one process and article thread, sends only the continuation after success', async () => {
  const f = fixture();
  try {
    const events = [];
    const first = await f.runtime.run({ ...f.options, onEvent: event => events.push(event) });
    const cached = f.runtime.getSession(f.options);
    assert.deepEqual(cached, { sessionId: first.sessionId, loadedChunks: 1, turns: 1 });
    const second = await f.runtime.run({ ...f.options, expectedSessionId: cached.sessionId });
    assert.equal(f.children.length, 1);
    assert.equal(methods(f, 'initialize').length, 1);
    assert.equal(methods(f, 'thread/start').length, 1);
    assert.deepEqual(methods(f, 'turn/start').map(x => x.params.input[0].text), ['full context', 'next question']);
    assert.equal(first.resumed, false); assert.equal(second.resumed, true);
    assert.equal(first.answer, '中文答案'); assert.equal(first.persistent, false);
    assert.equal(first.transport, 'app-server');
    assert.ok(first.timings.startupMs >= 0);
    assert.ok(first.timings.firstOutputMs >= first.timings.startupMs);
    assert.ok(first.timings.totalMs >= first.timings.firstOutputMs);
    assert.deepEqual(first.usage, { in: 20, out: 4, cacheRead: 12, cacheWrite: 0 });
    assert.deepEqual(events.filter(event => event.type === 'answer').map(event => event.text), ['中文', '中文答案', '中文答案']);
    assert.ok(!events.some(event => event.type === 'answer' && event.text.includes('PRIVATE')));
    assert.equal(f.runtime.getSession(f.options).loadedChunks, 2);
  } finally { f.runtime.close(); }
});

await test('different articles share a process but not a thread; connection checks do not replace it', async () => {
  const f = fixture();
  try {
    const first = await f.runtime.run(f.options);
    const other = await f.runtime.run({ ...f.options, contextKey: 'article-B' });
    await f.runtime.run({ ...f.options, connectionTest: true });
    assert.notEqual(first.sessionId, other.sessionId);
    assert.equal(f.children.length, 1);
    assert.equal(methods(f, 'thread/start').length, 3);
    assert.equal(f.runtime.getSession(f.options).sessionId, first.sessionId);
  } finally { f.runtime.close(); }
});

await test('stale session lookup rebuilds full context instead of appending to an unexpected thread', async () => {
  const f = fixture();
  try {
    await f.runtime.run(f.options);
    const result = await f.runtime.run({ ...f.options, expectedSessionId: 'expired' });
    assert.equal(result.resumed, false);
    assert.equal(methods(f, 'thread/start').length, 2);
    assert.equal(methods(f, 'turn/start').at(-1).params.input[0].text, 'full context');
  } finally { f.runtime.close(); }
});

await test('configuration and permission profiles are isolated; full does not force wider sandbox access', async () => {
  const f = fixture();
  try {
    await f.runtime.run(f.options);
    await f.runtime.run({ ...f.options, profile: 'full' });
    await f.runtime.run({ ...f.options, env: { CODEX_HOME: '/fake/other-home' } });
    assert.equal(f.children.length, 3);
    const params = methods(f, 'thread/start').map(x => x.params);
    assert.equal(params[0].sandbox, 'read-only');
    assert.equal(params[1].sandbox, undefined);
    assert.ok(params.every(x => x.ephemeral === true && x.approvalPolicy === 'never'));
    for (const name of ['shell_tool', 'unified_exec', 'js_repl', 'code_mode', 'multi_agent', 'multi_agent_v2', 'computer_use']) {
      assert.equal(params[0].config[`features.${name}`], false);
      const at = f.children[0].argv.indexOf(name);
      assert.equal(f.children[0].argv[at - 1], '--disable');
    }
    assert.equal(params[1].config, undefined);
  } finally { f.runtime.close(); }
});

await test('clearing a notes directory revokes its tool session even when cwd stays the same', async () => {
  const f = fixture();
  try {
    const result = await f.runtime.run({ ...f.options, notesDir: tmpdir() });
    assert.equal(f.runtime.getSession(f.options), null);
    const next = await f.runtime.run({ ...f.options, expectedSessionId: result.sessionId });
    assert.equal(next.resumed, false);
    assert.equal(f.children.length, 2);
    const params = methods(f, 'thread/start').map(x => x.params);
    assert.equal(params[0].dynamicTools.length, 2);
    assert.equal(params[1].dynamicTools, undefined);
  } finally { await f.runtime.close(); }
});

await test('failed terminal status never commits an intermediate answer or reusable thread', async () => {
  const f = fixture({ handler({ message, send }) {
    if (message.method !== 'turn/start') return;
    const threadId = message.params.threadId;
    send({ id: message.id, result: { turn: { id: 'failed-turn' } } });
    send({ method: 'item/completed', params: { threadId, turnId: 'failed-turn', item: { id: 'a', type: 'agentMessage', text: 'not a completed answer' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'failed-turn', status: 'failed', error: { message: 'test failure' } } } });
    return true;
  } });
  try {
    await assert.rejects(f.runtime.run(f.options), error => error.code === 'AGENT_ERROR' && error.submitted === true);
    assert.equal(f.runtime.getSession(f.options), null);
    assert.equal(f.children[0].signalCode, 'SIGTERM');
    assert.equal(methods(f, 'turn/start').length, 1);
  } finally { f.runtime.close(); }
});

await test('cancel sends interrupt and destroys uncertain state without replaying the turn', async () => {
  const controller = new AbortController();
  const f = fixture({ handler({ message, send }) {
    if (message.method !== 'turn/start') return;
    send({ id: message.id, result: { turn: { id: 'waiting-turn' } } });
    setImmediate(() => controller.abort());
    return true;
  } });
  try {
    await assert.rejects(f.runtime.run({ ...f.options, signal: controller.signal }), error => error.code === 'ABORTED');
    assert.equal(methods(f, 'turn/interrupt').length, 1);
    assert.equal(methods(f, 'turn/start').length, 1);
    assert.equal(f.runtime.getSession(f.options), null);
    assert.equal(f.children[0].signalCode, 'SIGTERM');
  } finally { f.runtime.close(); }
});

await test('startup timeout terminates the process and leaves no cached session', async () => {
  const f = fixture({ handler: ({ message }) => message.method === 'initialize', rpcTimeoutMs: 1000 });
  try {
    await assert.rejects(f.runtime.run({ ...f.options, timeoutMs: 10 }), error => error.code === 'AGENT_TIMEOUT' && error.submitted === false);
    assert.equal(f.children[0].signalCode, 'SIGTERM');
    assert.equal(f.runtime.servers.size, 0);
    assert.equal(methods(f, 'turn/start').length, 0);
  } finally { f.runtime.close(); }
});

await test('only explicit unsupported-method errors are eligible for pre-submission fallback', async () => {
  const f = fixture({ handler({ message, send }) {
    if (message.method !== 'thread/start') return;
    send({ id: message.id, error: { code: -32601, message: 'method not found' } });
    return true;
  } });
  try {
    await assert.rejects(f.runtime.run(f.options), error => error.code === 'CODEX_UNSUPPORTED' && error.submitted === false);
    assert.equal(methods(f, 'turn/start').length, 0);
  } finally { f.runtime.close(); }
});

await test('RPC and terminal turn provider failures share safe classification without replaying a model task', async () => {
  for (const mode of ['rpc', 'turn', 'notification']) {
    const providerError = { message: JSON.stringify({ error: { code: 'unsupported_value', param: 'reasoning.effort',
      message: 'Reasoning effort unsupported; Authorization: Bearer sk_PRIVATE' } }) };
    const f = fixture({ handler({ message, send }) {
      if (message.method !== 'turn/start') return;
      if (mode === 'rpc') send({ id: message.id, error: { code: -32000, ...providerError } });
      else {
        const threadId = message.params.threadId, turnId = 'failed-provider-turn';
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
        if (mode === 'turn') send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: providerError } } });
        else send({ method: 'error', params: { threadId, turnId, willRetry: false, error: providerError } });
      }
      return true;
    } });
    try {
      await assert.rejects(() => f.runtime.run(f.options), error => error.code === 'AGENT_REASONING_UNSUPPORTED'
        && error.submitted === true && !/sk_PRIVATE|Authorization|unsupported_value/.test(error.message));
      assert.equal(methods(f, 'turn/start').length, 1); assert.equal(f.runtime.servers.size, 0);
    } finally { await f.runtime.close(); }
  }
});

await test('idle expiry frees processes; the next request rebuilds context', async () => {
  const f = fixture({ idleMs: 10 });
  try {
    const first = await f.runtime.run(f.options);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.runtime.getSession(f.options), null);
    const second = await f.runtime.run({ ...f.options, expectedSessionId: first.sessionId });
    assert.equal(f.children.length, 2);
    assert.equal(second.resumed, false);
    assert.equal(methods(f, 'turn/start').at(-1).params.input[0].text, 'full context');
  } finally { f.runtime.close(); }
});

await test('concurrent calls serialize and cannot mix events across article threads', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.runtime.run(f.options), f.runtime.run({ ...f.options, contextKey: 'article-B' })]);
    assert.equal(f.children.length, 1);
    assert.notEqual(results[0].sessionId, results[1].sessionId);
    assert.ok(results.every(result => result.answer === '中文答案'));
  } finally { f.runtime.close(); }
});

await test('unexpected process exit invalidates pending RPCs instead of hanging', async () => {
  const f = fixture({ handler({ message, child }) {
    if (message.method !== 'turn/start') return;
    child.exitCode = 1; child.emit('close', 1); return true;
  } });
  try {
    await assert.rejects(f.runtime.run(f.options), error => error.code === 'CODEX_DISCONNECTED');
    assert.equal(f.runtime.getSession(f.options), null);
    assert.equal(f.runtime.servers.size, 0);
  } finally { f.runtime.close(); }
});

await test('server approval requests receive explicit denials using the correct response schema', async () => {
  let threadId, replies = 0;
  const f = fixture({ handler({ message, send }) {
    if (message.method === 'turn/start') {
      threadId = message.params.threadId;
      send({ id: message.id, result: { turn: { id: 'approval-turn' } } });
      for (const [id, method] of [
        ['permissions', 'item/permissions/requestApproval'],
        ['command', 'item/commandExecution/requestApproval'],
        ['elicitation', 'mcpServer/elicitation/request'],
        ['question', 'item/tool/requestUserInput'],
      ]) send({ id, method, params: { threadId, turnId: 'approval-turn' } });
      return true;
    }
    if (!message.method && typeof message.id === 'string') {
      if (++replies === 4) send({ method: 'turn/completed', params: { threadId, turn: { id: 'approval-turn', status: 'completed', items: [
        { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '已跳过需要授权的操作' },
      ] } } });
      return true;
    }
  } });
  try {
    await f.runtime.run(f.options);
    const reply = id => f.requests.find(x => x.id === id && !x.method)?.result;
    assert.deepEqual(reply('permissions'), { permissions: {}, scope: 'turn' });
    assert.deepEqual(reply('command'), { decision: 'decline' });
    assert.deepEqual(reply('elicitation'), { action: 'decline', content: null });
    assert.deepEqual(reply('question'), { answers: {} });
  } finally { f.runtime.close(); }
});

await test('Safe note tools return bounded sourced data only for the active thread', async () => {
  const notes = await mkdtemp(join(tmpdir(), 'contextflow-codex-tools-'));
  await writeFile(join(notes, 'reading.md'), '第一行\n第二行');
  let threadId, responses = 0;
  const f = fixture({ handler({ message, send }) {
    if (message.method === 'turn/start') {
      threadId = message.params.threadId;
      send({ id: message.id, result: { turn: { id: 'tools-turn' } } });
      send({ id: 'read-note', method: 'item/tool/call', params: { threadId, turnId: 'tools-turn', tool: 'contextflow_read_note', arguments: { path: 'reading.md', maxLines: 1 } } });
      send({ id: 'wrong-thread', method: 'item/tool/call', params: { threadId: 'other-thread', turnId: 'tools-turn', tool: 'contextflow_read_note', arguments: { path: 'reading.md' } } });
      send({ id: 'old-turn', method: 'item/tool/call', params: { threadId, turnId: 'previous-turn', tool: 'contextflow_read_note', arguments: { path: 'reading.md' } } });
      return true;
    }
    if (!message.method && ['read-note', 'wrong-thread', 'old-turn'].includes(message.id)) {
      if (++responses === 3) send({ method: 'turn/completed', params: { threadId, turn: { id: 'tools-turn', status: 'completed', items: [
        { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '参见 reading.md 第 1 行' },
      ] } } });
      return true;
    }
  } });
  try {
    await f.runtime.run({ ...f.options, notesDir: notes });
    assert.equal(methods(f, 'thread/start')[0].params.dynamicTools.length, 2);
    const result = f.requests.find(x => x.id === 'read-note' && !x.method)?.result;
    assert.equal(result.success, true);
    const note = JSON.parse(result.contentItems[0].text);
    assert.equal(note.path, 'reading.md');
    assert.ok(JSON.stringify(note).includes('第一行'));
    assert.ok(!JSON.stringify(note).includes('第二行'));
    assert.equal(f.requests.find(x => x.id === 'wrong-thread' && !x.method)?.result.success, false);
    assert.equal(f.requests.find(x => x.id === 'old-turn' && !x.method)?.result.success, false);
  } finally { f.runtime.close(); await rm(notes, { recursive: true, force: true }); }
});

await test('note directory authorization stays pinned across turns when its symlink is replaced', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'contextflow-codex-root-'));
  const firstRoot = join(temp, 'first'), secondRoot = join(temp, 'second'), link = join(temp, 'notes');
  await mkdir(firstRoot); await mkdir(secondRoot);
  await writeFile(join(firstRoot, 'note.md'), 'authorized first root');
  await writeFile(join(secondRoot, 'note.md'), 'unexpected second root');
  await symlink(firstRoot, link);
  let threadId, turnNo = 0;
  const f = fixture({ handler({ message, send }) {
    if (message.method === 'turn/start') {
      threadId = message.params.threadId;
      const turnId = `root-turn-${++turnNo}`;
      send({ id: message.id, result: { turn: { id: turnId } } });
      send({ id: `read-root-${turnNo}`, method: 'item/tool/call', params: { threadId, turnId, tool: 'contextflow_read_note', arguments: { path: 'note.md' } } });
      return true;
    }
    if (!message.method && String(message.id).startsWith('read-root-')) {
      send({ method: 'turn/completed', params: { threadId, turn: { id: `root-turn-${turnNo}`, status: 'completed', items: [
        { type: 'agentMessage', id: 'answer', text: '完成读取尝试' },
      ] } } });
      return true;
    }
  } });
  try {
    const result = await f.runtime.run({ ...f.options, notesDir: link });
    await unlink(link); await symlink(secondRoot, link);
    await f.runtime.run({ ...f.options, notesDir: link, expectedSessionId: result.sessionId });
    const reads = f.requests.filter(x => !x.method && String(x.id).startsWith('read-root-'));
    assert.equal(reads[0].result.success, true);
    assert.equal(reads[1].result.success, false);
    assert.ok(!JSON.stringify(reads[1]).includes('unexpected second root'));
    assert.equal(f.children.length, 1);
  } finally { f.runtime.close(); await rm(temp, { recursive: true, force: true }); }
});

await test('shutdown waits for SIGKILL when a real app-server child ignores SIGTERM', async () => {
  let child;
  const runtime = createCodexRuntime({ interruptMs: 30, spawnProcess(_bin, _argv, options) {
    child = spawn(process.execPath, ['-e', `
      process.on('SIGTERM', () => {});
      const readline = require('node:readline');
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.method === 'initialize') send({ id: m.id, result: {} });
        if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thread' } } });
        if (m.method === 'turn/start') {
          send({ id: m.id, result: { turn: { id: 'turn' } } });
          send({ method: 'turn/completed', params: { threadId: 'thread', turn: {
            id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'done' }]
          } } });
        }
      });
    `], options);
    return child;
  } });
  try {
    await runtime.run({ env: {}, bin: '/fake/codex', prompt: 'test', profile: 'safe', contextKey: 'article' });
    // Simulate jobs.shutdown invalidating a server before agent.close collects it.
    [...runtime.servers.values()][0].destroy();
    assert.equal(runtime.servers.size, 0);
    await runtime.close();
    assert.equal(child.signalCode, 'SIGKILL');
    await assert.rejects(runtime.run({ env: {}, prompt: 'after shutdown' }), error => error.code === 'CODEX_DISCONNECTED');
  } finally { await runtime.close(); }
});

console.log(`\n${pass} Codex app-server checks passed`);
