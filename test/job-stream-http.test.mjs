import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJobStream } from '../src/core/job-stream.js';

const dir = mkdtempSync(join(tmpdir(), 'contextflow-job-stream-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const gates = [];
const upstream = createServer(async (req, res) => {
  for await (const _ of req) { /* consume request without logging article or credentials */ }
  await new Promise(resolve => gates.push(resolve));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'Controlled final answer' } }] }));
});
let service, output = '', streams = [];
try {
  await listen(upstream);
  const reservation = createServer(); await listen(reservation);
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const token = 'stream-test-token';
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port, requireToken: true, token,
    translate: { provider: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}`, model: 'fixture', apiKey: 'fixture' },
    explain: { backend: 'llm' } }));
  service = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, CONTEXTFLOW_DIR: dir, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', data => { output += data; }); service.stderr.on('data', data => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'X-ContextFlow': '1', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (path, body) => {
    const response = await fetch(base + path, { headers, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    assert.equal(response.ok, true); return response.json();
  };
  for (let i = 0; i < 100; i++) {
    try { await call('/health'); break; } catch { if (i === 99) throw new Error(`Service not ready: ${output}`); await wait(40); }
  }
  assert.ok((await call('/health')).capabilities.includes('jobs.stream'));
  const submit = async text => (await call('/explain', { text, fresh: true, async: true })).job;
  const open = async job => {
    const controller = new AbortController(); streams.push(controller);
    return fetch(`${base}/jobs/${job.id}/stream`, { headers, signal: controller.signal });
  };

  const first = await submit('First controlled question');
  const denied = await fetch(`${base}/jobs/${first.id}/stream`, { headers: { 'X-ContextFlow': '1' } });
  assert.equal(denied.status, 401); await denied.body.cancel();
  const untrusted = await fetch(`${base}/jobs/${first.id}/stream`, { headers: { ...headers, Origin: 'https://untrusted.test' } });
  assert.equal(untrusted.status, 403); await untrusted.body.cancel();
  const snapshots = [], response = await open(first);
  const reading = readJobStream(response, job => snapshots.push(job));
  for (let i = 0; i < 100 && (!gates.length || !snapshots.length); i++) await wait(10);
  assert.equal(snapshots[0].status, 'running'); gates.shift()(); await reading;
  assert.equal(snapshots.at(-1).status, 'done');
  assert.equal(snapshots.at(-1).result.answer, 'Controlled final answer');

  const second = await submit('Second controlled question');
  const abandoned = await open(second); await abandoned.body.cancel();
  assert.equal((await call(`/jobs/${second.id}`)).job.status, 'running');
  for (let i = 0; i < 100 && !gates.length; i++) await wait(10);
  gates.shift()();
  for (let i = 0; i < 100; i++) { if ((await call(`/jobs/${second.id}`)).job.status === 'done') break; await wait(10); }
  assert.equal((await call(`/jobs/${second.id}`)).job.status, 'done');

  const third = await submit('Third controlled question');
  const shutdownSnapshots = [], shutdownStream = readJobStream(await open(third), job => shutdownSnapshots.push(job));
  const exiting = once(service, 'exit'), start = Date.now(); service.kill('SIGTERM');
  const [code] = await exiting; await shutdownStream;
  assert.equal(code, 0, output); assert.ok(Date.now() - start < 4000, 'SSE held shutdown open');
  assert.equal(shutdownSnapshots.at(-1).status, 'canceled');
  console.log('HTTP SSE：认证与来源检查、运行到完成快照、断流不取消任务、带活动订阅正常关闭服务通过');
} finally {
  for (const controller of streams) controller.abort();
  for (const release of gates) release();
  if (service && service.exitCode === null) { service.kill('SIGTERM'); await once(service, 'exit'); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
