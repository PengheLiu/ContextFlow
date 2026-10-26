// Full isolated HTTP/core/real child-protocol coverage. The executable is a
// temporary JSON-RPC fixture; no account, model, personal config or note is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ServiceManager } from '../desktop/service.mjs';
import { terminateTree } from '../server/platform.mjs';
import { productState } from '../desktop/ui/product-state.js';

test('isolated core invalidates Codex config receipts, binds draft/save identity, and rejects a login refresh during testing',
  { skip: process.platform === 'win32' || /\s/.test(process.execPath), timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-codex-config-core-')), data = join(root, 'data'), bin = join(root, 'bin'),
    home = join(root, 'profile-one'), second = join(root, 'profile-two'), mode = join(root, 'mode'), started = join(root, 'test-started'), release = join(root, 'release');
  for (const path of [data, bin, home, second]) mkdirSync(path);
  for (const path of [home, second]) { writeFileSync(join(path, 'config.toml'), 'model="private-fixture-model"\n'); writeFileSync(join(path, 'auth.json'), '{"fixture":"private-token"}'); }
  writeFileSync(mode, 'ok');
  const program = `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli fixture-v1');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let buffer='';
process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const m=JSON.parse(raw);
if(m.method==='initialize')send({id:m.id,result:{userAgent:'private fixture'}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'fixture-thread'}}});
if(m.method==='turn/start'){const threadId=m.params.threadId,turnId='fixture-turn';send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
 const current=fs.readFileSync(${JSON.stringify(mode)},'utf8').trim();const complete=()=>{
 if(current==='model'){send({method:'error',params:{threadId,turnId,willRetry:false,error:{message:JSON.stringify({error:{code:'model_not_found',message:'private model unavailable'}})}}});return}
 send({method:'item/completed',params:{threadId,turnId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'OK'}}});
 send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[]}}});};
 if(current==='wait'){fs.writeFileSync(${JSON.stringify(started)},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);complete()}},10)}else complete();
}
}});
`;
  for (const name of ['codex', 'claude', 'dsh', 'gemini']) { writeFileSync(join(bin, name), program); chmodSync(join(bin, name), 0o755); }
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ port, token: 'fixture-token', requireToken: true, explain: { backend: 'agent' },
    agent: { id: 'codex', executable: join(bin, 'codex'), profile: 'safe', notesDir: '', env: { CODEX_HOME: home } },
    translate: { chunkChars: 0 }, sync: { backend: 'markdown' }, markdown: { dir: join(root, 'notes'), folder: '/reading' } }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|API.?KEY|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|AUTH)/i.test(key)
    && !/^(?:CONTEXTFLOW_|CODEX_|DSH_|CLAUDE_|ANTHROPIC_|OPENAI_|GEMINI_)/.test(key)
    && !['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(key)));
  Object.assign(environment, { PATH: bin, HOME: root, CODEX_HOME: home, CONTEXTFLOW_DSH_BIN: join(bin, 'dsh') });
  let service;
  try {
    service = new ServiceManager({ paths: { data, logs: join(root, 'logs') }, runtime: process.execPath,
      core: fileURLToPath(new URL('..', import.meta.url)), secretKey: randomBytes(32).toString('base64'), terminateTree, environment });
    await service.start(); assert.equal(service.state, 'running', service.message);
    const request = async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
        'Content-Type': 'application/json', 'X-ContextFlow': '1', Authorization: `Bearer ${service.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      const value = await response.json(); assert.ok([200, 202].includes(response.status), JSON.stringify(value)); return value;
    };
    const finish = async initial => {
      let job = initial.job; const deadline = Date.now() + 5000;
      while (['queued', 'running'].includes(job.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 15)); ({ job } = await request(`/jobs/${job.id}`)); }
      return job;
    };
    const check = body => request('/agents/test', { id: 'codex', profile: 'safe', ...body }).then(finish);
    const answer = () => request('/explain', { text: 'A public fixture passage', question: 'Explain', urlKey: 'codex-readiness-fixture', fresh: true }).then(finish);
    const frame = () => request('/desktop/state');
    assert.equal((await check()).status, 'done'); assert.equal((await answer()).status, 'done');
    let state = await frame(); assert.equal(state.configuration.connectionChecks.agents.codex.ok, true); assert.equal(state.health.readingStatus.ai.verified, true);

    writeFileSync(join(home, 'config.toml'), 'model="changed-private-fixture-model"\n');
    state = await frame(); assert.equal(state.configuration.connectionChecks.agents.codex, undefined); assert.equal(state.health.readingStatus.ai.verified, false);
    assert.equal((await check()).status, 'done'); assert.equal((await answer()).status, 'done');
    writeFileSync(mode, 'model'); const failed = await answer(); assert.equal(failed.error.code, 'AGENT_MODEL_UNAVAILABLE');
    state = await frame(); assert.equal(state.health.readingStatus.ai.verified, false);
    assert.equal(productState({ service: { state: 'running' }, readingStatus: state.health.readingStatus }, state.configuration).ai.ok, false);

    writeFileSync(mode, 'ok'); assert.equal((await check({ codexHome: second })).status, 'done');
    await request('/config', { agent: { id: 'codex', codexHome: second } });
    state = await frame(); assert.equal(state.configuration.agent.codexHome, second); assert.equal(state.configuration.connectionChecks.agents.codex.ok, true);

    writeFileSync(mode, 'wait'); const pending = await request('/agents/test', { id: 'codex', profile: 'safe' });
    const deadline = Date.now() + 3000; while (!existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(started), true); writeFileSync(join(second, 'auth.json'), '{"fixture":"refreshed-private-token"}'); writeFileSync(release, 'release');
    const changed = await finish(pending); assert.equal(changed.error.code, 'AGENT_CONFIGURATION_CHANGED');
    state = await frame(); assert.equal(state.configuration.connectionChecks.agents.codex, undefined); assert.equal(state.health.readingStatus.ai.verified, false);
    for (const file of ['reading-status.json', 'connection-checks.json']) assert.doesNotMatch(readFileSync(join(data, file), 'utf8'), /private-token|fixture-model|cf-codex-config-core/);
  } finally { await service?.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});
