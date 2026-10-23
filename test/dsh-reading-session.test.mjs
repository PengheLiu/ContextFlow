// Exercise lookup and Agent integration with a local DSH protocol fixture.
// No personal Harness profile, credentials, or model are used.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'cf-dsh-reading-'));
const bin = join(directory, 'bin'), notes = join(directory, 'notes');
mkdirSync(bin); mkdirSync(notes);
const log = join(directory, 'requests.jsonl');
const previousDir = process.env.CONTEXTFLOW_DIR, previousPath = process.env.PATH;
process.env.PATH = bin + ':' + (previousPath || '');
process.env.CONTEXTFLOW_DIR = join(directory, 'data');
mkdirSync(process.env.CONTEXTFLOW_DIR);

// The installed 0.1.0-rc.6 public web transport uses HTTP commands and
// WebSocket event envelopes. Keep this fixture independent of the adapter.
function dshFixture() {
  if (process.argv.includes('--version')) { console.log(process.env.CF_TEST_VERSION || '0.1.0-rc.6'); process.exit(0); }
  const fs = require('node:fs');
  const http = require('node:http');
  const { randomUUID, createHash } = require('node:crypto');
  const assert = require('node:assert/strict');
  const sessions = new Map(), mux = new Set(), host = new Set();
  let sequence = 0;
  const record = (method, payload) => fs.appendFileSync(process.env.CF_TEST_LOG, JSON.stringify({
    pid: process.pid, home: process.env.DSH_HOME, cwd: process.cwd(),
    argv: process.argv.slice(2), method, payload,
  }) + '\n');
  record('process.started', {});
  if (process.argv[3] === 'headless') {
    assert.equal(process.argv.length, 5);
    record('headless.prompt', { text: process.argv[4] });
    process.stdout.write('兼容答案\n');
    process.exit(Number(process.env.CF_TEST_EXIT) || 0);
  }
  assert.deepEqual(process.argv.slice(2), ['--profile', 'web', '--host', '127.0.0.1', '--port', '0']);
  function send(socket, value) {
    const body = Buffer.from(JSON.stringify(value));
    let header;
    if (body.length < 126) header = Buffer.from([0x81, body.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); }
    socket.write(Buffer.concat([header, body]));
  }
  function frame(payload, target) {
    const value = { type: 'server-request', rpcId: randomUUID(), method: payload.type, payload };
    for (const socket of target ? [target] : mux) send(socket, value);
  }
  function event(sessionId, type, data) {
    const session = sessions.get(sessionId);
    const item = { type, seq: session.seq++, time: Date.now(), data };
    session.events.push({ event: item });
    frame({ type: 'session/event', sessionId, event: item });
  }
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/')) { res.writeHead(404).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw), payload = request.payload || {};
    assert.equal(request.type, 'client-request');
    assert.equal(req.url, '/api/' + request.method);
    assert.equal(typeof request.rpcId, 'string');
    record(request.method, payload);
    const reply = value => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }));
    };
    if (request.method === 'host.describe') return reply({ name: 'DSH fixture', version: '0.1.0-rc.6' });
    if (request.method === 'session.create') {
      const sessionId = payload.sessionId || 'session-' + process.pid + '-' + (++sequence);
      assert.equal(sessions.has(sessionId), false);
      sessions.set(sessionId, { turn: 0, seq: 0, events: [] });
      frame({ type: 'session/subscribed', sessionId, lastSeq: -1 });
      return reply({ sessionId });
    }
    if (request.method === 'session.history') {
      assert.ok(sessions.has(payload.sessionId));
      return reply({ events: sessions.get(payload.sessionId).events, hasMore: false });
    }
    if (request.method === 'session.cancel') return reply({ accepted: true });
    if (request.method === 'session.prompt') {
      assert.equal(payload.mode, 'queue');
      const sessionId = payload.sessionId, session = sessions.get(sessionId);
      assert.ok(session, 'prompt must reference a created session');
      assert.ok(mux.size > 0, 'subscribe before submitting a model task');
      const turn = ++session.turn;
      reply({ accepted: true });
      event(sessionId, 'turn/start', { turn });
      event(sessionId, 'user/message', { id: randomUUID(), role: 'user', content: payload.content,
        source: { kind: 'user', rpcId: request.rpcId } });
      event(sessionId, 'assistant/chunk', { turn, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'PRIVATE REASONING' } });
      event(sessionId, 'assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', index: 1, text: '逐步' } });
      setTimeout(() => {
        event(sessionId, 'assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', index: 1, text: '答案' } });
        event(sessionId, 'assistant/message', { turn, step: 0,
          message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: '逐步答案' }] },
          usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 12, cacheWriteTokens: 0 } });
        event(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
      }, 25);
      return;
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    const streams = req.url === '/api/events.mux' ? mux : req.url === '/api/events.host' ? host : null;
    if (!streams) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    streams.add(socket);
    socket.on('error', () => streams.delete(socket));
    socket.on('close', () => streams.delete(socket));
    // The client never sends application messages. Acknowledge close frames.
    socket.on('data', chunk => { if ((chunk[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0])); });
    if (streams === mux) for (const [sessionId, session] of sessions) frame({ type: 'session/subscribed', sessionId, lastSeq: session.seq - 1 }, socket);
  });
  server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port));
}
writeFileSync(join(bin, 'dsh'), '#!/usr/bin/env node\n(' + dshFixture.toString() + ')();\n', { mode: 0o700 });

const db = await import('../server/db.mjs');
const lookup = await import('../server/lookup.mjs');
const agent = await import('../server/agent.mjs');
const cfg = {
  agent: { id: 'dsh', profile: 'full', notesDir: notes, timeoutMs: 5000,
    env: { PATH: process.env.PATH, CONTEXTFLOW_DSH_BIN: join(bin, 'dsh'), DSH_HOME: join(directory, 'harness'), CF_TEST_LOG: log } },
  translate: { chunkChars: 100, tailChars: 20, contextBudget: 60000 },
};
const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const prompts = () => calls().filter(row => row.method === 'session.prompt');
const textOf = row => row.payload.content.map(part => part.text || '').join('\n');
let pass = 0;
const test = async (name, run) => { await run(); pass++; console.log('  ok   ' + name); };
const ask = (question, extra = {}) => lookup.explainViaAgent({
  urlKey: 'article:A', text: '选区', offset: 5, question, fresh: true, cfg, ...extra,
});
const save = (id, question, answer) => db.upsertEvents([{
  id, urlKey: 'article:A', action: 'explain', text: '选区', value: answer,
  createdAt: Date.now(), anchor: { start: 5 }, extra: { question },
}]);

try {
  lookup.putArticle({ urlKey: 'article:A', title: 'A', url: 'https://example.com/a', text: 'a'.repeat(400) });
  await test('DSH Full 首轮启动常驻服务，答案增量先于完成且不混入推理内容', async () => {
    const previews = [];
    let finished = false;
    const result = await ask('第一问', { onEvent: event => {
      if (event.type === 'answer') { assert.equal(finished, false); previews.push(event.text); }
    } });
    finished = true;
    assert.equal(result.answer, '逐步答案');
    assert.equal(result.agentMeta.resumed, false);
    assert.equal(result.agentMeta.transport, 'dsh-web');
    assert.ok(previews.includes('逐步'));
    assert.ok(previews.every(text => !text.includes('PRIVATE REASONING')));
    const created = calls().find(row => row.method === 'session.create');
    assert.equal(created.home, cfg.agent.env.DSH_HOME);
    assert.equal(created.payload.cwd, notes);
    assert.match(textOf(prompts()[0]), /第一问/);
    assert.match(textOf(prompts()[0]), /<article part="1\/4">/);
    save('first', '第一问', result.answer);
    assert.equal(db.getAgentSession('article:A', 'dsh'), null);
  });

  await test('同文章第二问复用 PID 和 session，只追加新问题', async () => {
    const result = await ask('第二问');
    const sent = prompts();
    assert.equal(result.agentMeta.resumed, true);
    assert.equal(sent[0].pid, sent[1].pid);
    assert.equal(sent[0].payload.sessionId, sent[1].payload.sessionId);
    assert.match(textOf(sent[1]), /第二问/);
    assert.doesNotMatch(textOf(sent[1]), /第一问|<article part=/);
    save('second', '第二问', result.answer);
  });

  await test('新选区补足正文，其他文章共享服务但独立 session', async () => {
    await ask('后文问题', { offset: 150 });
    assert.match(textOf(prompts().at(-1)), /<article part="2\/4">/);
    assert.doesNotMatch(textOf(prompts().at(-1)), /<article part="1\/4">/);
    lookup.putArticle({ urlKey: 'article:B', title: 'B', url: 'https://example.com/b', text: 'b'.repeat(300) });
    const result = await ask('另一篇', { urlKey: 'article:B' });
    const sent = prompts();
    assert.equal(result.agentMeta.resumed, false);
    assert.equal(sent[0].pid, sent.at(-1).pid);
    assert.notEqual(sent[0].payload.sessionId, sent.at(-1).payload.sessionId);
    assert.doesNotMatch(textOf(sent.at(-1)), /第一问|第二问/);
  });

  await test('正文或分段配置变化会重建文章 session', async () => {
    const before = prompts()[0].payload.sessionId;
    lookup.putArticle({ urlKey: 'article:A', title: 'A', url: 'https://example.com/a', text: 'changed'.repeat(80) });
    const changed = await ask('新版');
    assert.equal(changed.agentMeta.resumed, false);
    assert.notEqual(prompts().at(-1).payload.sessionId, before);
    assert.match(textOf(prompts().at(-1)), /changed/);
    const chunked = await ask('新分段', { cfg: { ...cfg, translate: { ...cfg.translate, chunkChars: 200 } } });
    assert.equal(chunked.agentMeta.resumed, false);
  });

  await test('DSH 进程退出后从阅读记录重建，不使用旧数据库 session', async () => {
    const oldPid = prompts().at(-1).pid;
    process.kill(oldPid, 'SIGTERM');
    let exited = false;
    for (let attempt = 0; attempt < 100 && !exited; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try { process.kill(oldPid, 0); } catch { exited = true; }
    }
    assert.equal(exited, true);
    db.putAgentSession('article:A', 'dsh', 'legacy-headless-session', 20, 99);
    const result = await ask('重建问题');
    const sent = prompts().at(-1);
    assert.equal(result.agentMeta.resumed, false);
    assert.notEqual(sent.pid, oldPid);
    assert.notEqual(sent.payload.sessionId, 'legacy-headless-session');
    assert.match(textOf(sent), /第一问/);
    assert.match(textOf(sent), /第二问/);
    assert.match(textOf(sent), /<article part=/);
  });

  await test('DSH_HOME 或笔记目录改变不能续接之前的进程会话', async () => {
    const otherNotes = join(directory, 'other-notes'); mkdirSync(otherNotes);
    for (const configuration of [
      { ...cfg.agent, env: { ...cfg.agent.env, DSH_HOME: join(directory, 'other-harness') } },
      { ...cfg.agent, notesDir: otherNotes },
    ]) {
      const priorPid = prompts().at(-1).pid;
      const result = await ask('配置变化', { cfg: { ...cfg, agent: configuration } });
      assert.equal(result.agentMeta.resumed, false);
      assert.notEqual(prompts().at(-1).pid, priorPid);
      assert.match(textOf(prompts().at(-1)), /第一问/);
    }
  });

  await test('速览和解释共享文章会话，且第二轮携带自己的回答要求', async () => {
    lookup.putArticle({ urlKey: 'article:C', title: 'C', url: 'https://example.com/c', text: 'c'.repeat(400) });
    const summary = await lookup.summarize({ urlKey: 'article:C', fresh: true,
      cfg: { ...cfg, explain: { backend: 'agent' } } });
    assert.equal(summary.summary, '逐步答案');
    const summaryPrompt = prompts().at(-1);
    assert.match(textOf(summaryPrompt), /200 字以内概述/);
    const result = await ask('速览之后的具体问题', { urlKey: 'article:C' });
    const explanation = prompts().at(-1);
    assert.equal(result.agentMeta.resumed, true);
    assert.equal(explanation.pid, summaryPrompt.pid);
    assert.equal(explanation.payload.sessionId, summaryPrompt.payload.sessionId);
    assert.match(textOf(explanation), /速览之后的具体问题/);
    assert.doesNotMatch(textOf(explanation), /200 字以内概述|<article part=/);
  });

  await test('Safe 拒绝 DSH，不能借常驻接入自动提升到 Full', async () => {
    const before = calls().length;
    await assert.rejects(ask('安全档问题', { cfg: { ...cfg, agent: { ...cfg.agent, profile: 'safe' } } }),
      error => error.code === 'AGENT_SAFE_UNSUPPORTED');
    assert.equal(calls().length, before);
  });
  await test('未验证版本提交前回退 headless，每次发完整历史且不伪报续接', async () => {
    const legacyBin = join(directory, 'legacy-bin'); mkdirSync(legacyBin);
    writeFileSync(join(legacyBin, 'dsh'), '#!/usr/bin/env node\n(' + dshFixture.toString() + ')();\n', { mode: 0o700 });
    const fallback = { ...cfg, agent: { ...cfg.agent,
      env: { ...cfg.agent.env, CONTEXTFLOW_DSH_BIN: join(legacyBin, 'dsh'), PATH: legacyBin + ':' + process.env.PATH, CF_TEST_VERSION: '0.0.0-unverified' } } };
    const nativeBefore = prompts().length;
    for (const question of ['兼容第一问', '兼容第二问']) {
      const result = await ask(question, { cfg: fallback });
      assert.equal(result.answer, '兼容答案');
      assert.equal(result.agentMeta.resumed, false);
    }
    assert.equal(prompts().length, nativeBefore, 'a fallback must not submit the same task to the native API');
    const legacy = calls().filter(row => row.method === 'headless.prompt');
    assert.equal(legacy.length, 2);
    assert.notEqual(legacy[0].pid, legacy[1].pid);
    for (const sent of legacy) {
      assert.match(sent.payload.text, /第一问/);
      assert.match(sent.payload.text, /第二问/);
      assert.match(sent.payload.text, /<article part=/);
      assert.equal(sent.argv.includes('--resume'), false);
    }
    await assert.rejects(ask('失败不能保存答案', {
      cfg: { ...fallback, agent: { ...fallback.agent, env: { ...fallback.agent.env, CF_TEST_EXIT: '1' } } },
    }), error => error.code === 'AGENT_ERROR');
  });
  console.log('\n' + pass + ' 项 DSH 阅读会话集成测试通过（未调用真实模型）');
} finally {
  await agent.close();
  db.close?.();
  if (previousDir === undefined) delete process.env.CONTEXTFLOW_DIR;
  else process.env.CONTEXTFLOW_DIR = previousDir;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(directory, { recursive: true, force: true });
}
