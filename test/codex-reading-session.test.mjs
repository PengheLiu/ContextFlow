// 阅读上下文与常驻 Codex 的集成；仅使用临时目录中的协议替身，不调用模型。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cf-codex-reading-'));
const bin = join(dir, 'bin');
mkdirSync(bin);
const log = join(dir, 'rpc.jsonl');
const previousDir = process.env.CONTEXTFLOW_DIR;
const previousPath = process.env.PATH;
process.env.PATH = `${bin}:${previousPath}`;
process.env.CONTEXTFLOW_DIR = join(dir, 'data');
mkdirSync(process.env.CONTEXTFLOW_DIR);
writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const fs = require('node:fs');
const readline = require('node:readline');
let thread = 0, turn = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line), p = request.params || {};
  fs.appendFileSync(process.env.CF_TEST_LOG, JSON.stringify({pid:process.pid, home:process.env.CODEX_HOME,
    argv:process.argv.slice(2), method:request.method, params:p}) + '\\n');
  if (request.method === 'initialize') return send({id:request.id,result:{userAgent:'fixture'}});
  if (request.method === 'initialized') return;
  if (request.method === 'thread/start') return send({id:request.id,result:{thread:{id:'thread-'+process.pid+'-'+(++thread)}}});
  if (request.method === 'turn/start') {
    const id = 'turn-'+(++turn), threadId = p.threadId;
    send({id:request.id,result:{turn:{id,status:'inProgress'}}});
    send({method:'turn/started',params:{threadId,turn:{id,status:'inProgress'}}});
    send({method:'item/started',params:{threadId,turnId:id,item:{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:''}}});
    send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'answer-'+id,delta:'逐步'}});
    setTimeout(() => {
      send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'answer-'+id,delta:'答案'}});
      send({method:'item/completed',params:{threadId,turnId:id,item:{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:'逐步答案'}}});
      send({method:'turn/completed',params:{threadId,turn:{id,status:'completed'}}});
    }, 15);
    return;
  }
  if (request.id !== undefined) send({id:request.id,result:{}});
});
`, { mode: 0o700 });

const db = await import('../server/db.mjs');
const lookup = await import('../server/lookup.mjs');
const agent = await import('../server/agent.mjs');
const cfg = {
  agent: { id: 'codex', profile: 'safe', notesDir: '', timeoutMs: 5000,
    env: { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(dir, 'codex'), CF_TEST_LOG: log } },
  translate: { chunkChars: 100, tailChars: 20, contextBudget: 60000 },
};
const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const turns = () => calls().filter(row => row.method === 'turn/start');
const textOf = row => row.params.input.map(item => item.text || '').join('\n');
let pass = 0;
const test = async (name, fn) => {
  await fn(); pass++; console.log(`  ok   ${name}`);
};
const ask = (question, extra = {}) => lookup.explainViaAgent({
  urlKey: 'article:A', text: '选区', offset: 5, question, fresh: true, cfg, ...extra,
});
const save = (id, question, answer) => db.upsertEvents([{
  id, urlKey: 'article:A', action: 'explain', text: '选区', value: answer,
  createdAt: Date.now(), anchor: { start: 5 }, extra: { question },
}]);

try {
  lookup.putArticle({ urlKey: 'article:A', title: 'A', url: 'https://example.com/a', text: 'a'.repeat(400) });
  await test('Safe 首轮启动进程，输出到达时任务仍在进行', async () => {
    const updates = [];
    let finished = false;
    const result = await ask('第一问', { onEvent: event => {
      if (event.type === 'answer') { assert.equal(finished, false); updates.push(event.text); }
    } });
    finished = true;
    assert.equal(result.answer, '逐步答案');
    assert.equal(result.agentMeta.resumed, false);
    assert.ok(updates.some(text => text.includes('逐步')));
    assert.equal(new Set(calls().map(row => row.pid)).size, 1);
    const start = calls().find(row => row.method === 'thread/start');
    assert.equal(start.params.sandbox, 'read-only');
    assert.equal(start.params.ephemeral, true);
    assert.equal(start.home, cfg.agent.env.CODEX_HOME);
    assert.match(textOf(turns()[0]), /第一问/);
    assert.match(textOf(turns()[0]), /<article part="1\/4">/);
    save('first', '第一问', result.answer);
    assert.equal(db.getAgentSession('article:A', 'codex'), null);
  });

  await test('同文章第二问复用进程和线程，只追加新要求', async () => {
    const result = await ask('第二问');
    assert.equal(result.agentMeta.resumed, true);
    const submitted = turns();
    assert.equal(submitted[0].pid, submitted[1].pid);
    assert.equal(submitted[0].params.threadId, submitted[1].params.threadId);
    assert.match(textOf(submitted[1]), /第二问/);
    assert.doesNotMatch(textOf(submitted[1]), /第一问|<article part=/);
    save('second', '第二问', result.answer);
  });

  await test('选区移到后面时补足正文，跨文章只共享进程', async () => {
    await ask('后文问题', { offset: 150 });
    assert.match(textOf(turns().at(-1)), /<article part="2\/4">/);
    assert.doesNotMatch(textOf(turns().at(-1)), /<article part="1\/4">/);
    lookup.putArticle({ urlKey: 'article:B', title: 'B', url: 'https://example.com/b', text: 'b'.repeat(300) });
    const result = await ask('另一篇', { urlKey: 'article:B' });
    assert.equal(result.agentMeta.resumed, false);
    const submitted = turns();
    assert.equal(submitted[0].pid, submitted.at(-1).pid);
    assert.notEqual(submitted[0].params.threadId, submitted.at(-1).params.threadId);
    assert.doesNotMatch(textOf(submitted.at(-1)), /第一问|第二问/);
  });

  await test('正文版本或上下文分段设置变化时建立新线程', async () => {
    lookup.putArticle({ urlKey: 'article:A', title: 'A', url: 'https://example.com/a', text: 'changed'.repeat(80) });
    const prior = turns()[0].params.threadId;
    const result = await ask('新版');
    assert.equal(result.agentMeta.resumed, false);
    assert.notEqual(turns().at(-1).params.threadId, prior);
    assert.match(textOf(turns().at(-1)), /changed/);
    const changed = await ask('新分段', { cfg: { ...cfg, translate: { ...cfg.translate, chunkChars: 200 } } });
    assert.equal(changed.agentMeta.resumed, false);
  });

  await test('进程关闭后完整重建历史，不恢复旧 exec 临时会话', async () => {
    const oldPid = turns().at(-1).pid;
    // 模拟 Codex 子进程退出；agent.close() 是整个服务停机，不应允许再启动。
    process.kill(oldPid, 'SIGTERM');
    let exited = false;
    for (let tries = 0; tries < 100 && !exited; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try { process.kill(oldPid, 0); } catch { exited = true; }
    }
    assert.equal(exited, true, 'fixture process must exit before the next request');
    db.putAgentSession('article:A', 'codex', 'legacy-ephemeral', 20, 99);
    const result = await ask('重建问题');
    assert.equal(result.agentMeta.resumed, false);
    const submitted = turns().at(-1);
    assert.notEqual(submitted.pid, oldPid);
    assert.match(textOf(submitted), /第一问/);
    assert.match(textOf(submitted), /第二问/);
    assert.match(textOf(submitted), /<article part=/);
    assert.ok(!calls().some(row => row.method === 'thread/resume'));
  });

  await test('权限档和配置目录变化不能续接旧线程', async () => {
    for (const agentConfig of [
      { ...cfg.agent, profile: 'full' },
      { ...cfg.agent, env: { ...cfg.agent.env, CODEX_HOME: join(dir, 'another-profile') } },
    ]) {
      const result = await ask('配置变化', { cfg: { ...cfg, agent: agentConfig } });
      assert.equal(result.agentMeta.resumed, false);
      assert.match(textOf(turns().at(-1)), /第一问/);
    }
  });
  await test('速览与解释共用文章线程，同时保留每轮各自要求', async () => {
    lookup.putArticle({ urlKey: 'article:C', title: 'C', url: 'https://example.com/c', text: 'c'.repeat(400) });
    const summary = await lookup.summarize({ urlKey: 'article:C', fresh: true,
      cfg: { ...cfg, explain: { backend: 'agent' } } });
    assert.equal(summary.summary, '逐步答案');
    const summaryTurn = turns().at(-1);
    assert.match(textOf(summaryTurn), /200 字以内概述/);
    const result = await ask('速览之后的具体问题', { urlKey: 'article:C' });
    const explanationTurn = turns().at(-1);
    assert.equal(result.agentMeta.resumed, true);
    assert.equal(explanationTurn.pid, summaryTurn.pid);
    assert.equal(explanationTurn.params.threadId, summaryTurn.params.threadId);
    assert.match(textOf(explanationTurn), /速览之后的具体问题/);
    assert.doesNotMatch(textOf(explanationTurn), /200 字以内概述|<article part=/);
  });
  console.log(`\n${pass} 项阅读会话集成测试通过（未调用真实模型）`);
} finally {
  await agent.close();
  db.close?.();
  if (previousDir === undefined) delete process.env.CONTEXTFLOW_DIR;
  else process.env.CONTEXTFLOW_DIR = previousDir;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
}
