import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionChecks } from '../server/connection-checks.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'contextflow-checks-'));
const cfg = { translate: { provider:'openai', baseUrl:'https://model.test', model:'example', apiKey:'secret-never-persist' },
  agent:{id:'claude', env:{TOKEN:'private-agent-token'}} };
const installed = [{id:'claude',available:true,path:'/test/bin/claude',version:'1.0',safeSupport:'best-effort'},
  {id:'codex',available:true,path:'/test/bin/codex',version:'2.0',safeSupport:'verified'}];
try {
  let checks=new ConnectionChecks(temporary,'service-secret');
  assert.deepEqual(checks.view(cfg,installed),{model:null,agents:{}});
  const ticket=checks.begin(checks.modelKey(cfg));checks.finish(ticket,true,1000);
  const agentTicket=checks.begin(checks.agentKey({...installed[0],env:cfg.agent.env}));checks.finish(agentTicket,true,2000);
  assert.equal(checks.view(cfg,installed).model.checkedAt,1000);
  assert.equal(checks.view(cfg,installed).agents.claude.checkedAt,2000);
  assert.ok(!checks.view(cfg,installed).agents.codex);
  const stored=readFileSync(join(temporary,'connection-checks.json'),'utf8');
  assert.doesNotMatch(stored,/secret|TOKEN|private|model.test|claude|codex|example|test\/bin/);
  assert.equal(statSync(join(temporary,'connection-checks.json')).mode & 0o777,0o600);
  console.log('ok 只记录显式测试；按连接隔离，持久化仅含服务端 HMAC、结果与时间，不含密钥/路径/正文');

  checks=new ConnectionChecks(temporary,'service-secret');
  assert.equal(checks.view(cfg,installed).model.ok,true);
  assert.equal(checks.view(cfg,installed).agents.claude.ok,true);
  for(const patch of [{apiKey:'changed'}, {provider:'anthropic'}, {baseUrl:'https://other.test'}, {model:'other'}]) {
    assert.equal(checks.view({...cfg,translate:{...cfg.translate,...patch}},installed).model,null);
  }
  assert.equal(checks.view({...cfg,translate:{...cfg.translate,baseUrl:'https://model.test/v1/chat/completions/',target:'English',thinking:true}},installed).model.ok,true);
  assert.equal(checks.view({...cfg,agent:{...cfg.agent,env:{TOKEN:'new'}}},installed).agents.claude,undefined);
  assert.equal(checks.view(cfg,[{...installed[0],path:'/new/claude'}]).agents.claude,undefined);
  assert.equal(checks.view(cfg,[{...installed[0],version:'2.0'}]).agents.claude,undefined);
  assert.equal(checks.view(cfg,[{...installed[0],available:false}]).agents.claude,undefined);
  assert.equal(checks.view(cfg,[{...installed[0],safeSupport:'unsupported'}]).agents.claude,undefined);
  assert.equal(new ConnectionChecks(temporary,'new-service-secret').view(cfg,installed).model,null);
  console.log('ok 服务重启仍保留；模型/地址/密钥、CLI 路径/版本/凭据或服务身份变化不误用旧结果');

  const older=checks.begin(checks.modelKey(cfg)), newer=checks.begin(checks.modelKey(cfg));
  checks.finish(newer,false,3000);checks.finish(older,true,2500);
  assert.deepEqual(checks.view(cfg).model,{ok:false,checkedAt:3000});
  const retry=checks.begin(checks.modelKey(cfg));checks.finish(retry,true,4000);
  const canceled=checks.begin(checks.modelKey(cfg));checks.discard(canceled);checks.finish(canceled,false,5000);
  assert.deepEqual(checks.view(cfg).model,{ok:true,checkedAt:4000});
  for(let i=0;i<80;i++) checks.finish(checks.begin(checks.identity('test',i)),true,6000+i);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(temporary,'connection-checks.json'),'utf8'))).length,64);
  writeFileSync(join(temporary,'connection-checks.json'),'{corrupt');
  assert.equal(new ConnectionChecks(temporary,'service-secret').view(cfg).model,null);
  console.log('ok 新的失败覆盖旧成功，迟到请求不能覆盖新结果，取消不写结果；记录有界，损坏文件不假报成功');
} finally { rmSync(temporary,{recursive:true,force:true}); }
