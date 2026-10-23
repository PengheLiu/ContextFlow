import assert from 'node:assert/strict';
import { prepareAgentTest, testAgentConnection, agentTestConfig, CONNECTION_PROMPT } from '../server/agent-test.mjs';
import { _argvFor } from '../server/agent.mjs';
import { JSDOM } from 'jsdom';
import { wireDisclosure } from '../src/core/disclosure.js';
import { ConnectionChecks } from '../server/connection-checks.mjs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass=0;
async function test(name,fn){try{await fn();pass++;console.log(`  ok   ${name}`);}catch(error){process.exitCode=1;console.error(`  FAIL ${name}\n${error.stack}`);}}
const installed=async()=>[{id:'claude',label:'Claude Code',version:'test-version',available:true,safeSupport:'best-effort'},
  {id:'gemini',label:'Gemini CLI',available:true,safeSupport:'unsupported'}];
console.log('Agent 连接验证与可逆折叠\n');

await test('连接草稿严格限制字段，不写配置，不继承另一个CLI的路径、Full或凭证',async()=>{
  const cfg={agent:{id:'claude',executable:'/fixture/claude',profile:'full',env:{TOKEN:'private'},notesDir:'/private/notes'}};
  const original=JSON.stringify(cfg),draft=agentTestConfig({id:'codex'},cfg);
  assert.equal(draft.agent.id,'codex');assert.equal(draft.agent.executable,'');assert.equal(draft.agent.profile,'safe');assert.deepEqual(draft.agent.env,{});
  draft.agent.env.TOKEN='changed';assert.equal(JSON.stringify(cfg),original);
  const same=agentTestConfig({id:'claude',executable:'/fixture/new-claude',profile:'safe'},cfg);
  assert.equal(same.agent.executable,'/fixture/new-claude');assert.deepEqual(same.agent.env,{TOKEN:'private'});assert.equal(same.agent.profile,'safe');
  for(const body of [null,[],{id:'shell'},{id:'claude',env:{}},{id:'claude',notesDir:'/notes'},{id:'claude',prompt:'run tools'},
    {id:'claude',profile:'other'},{id:'claude',executable:22},{id:'claude',executable:'/bad\npath'},{id:'claude',executable:'alias --args'}]){
    assert.throws(()=>agentTestConfig(body,cfg));
  }
});

await test('程序草稿直接检测真实路径版本，Full草稿也只执行受限连接测试',async()=>{
  const cfg={agent:{id:'claude',executable:'/fixture/old',profile:'safe',env:{PROXY:'private'}}};
  const snapshot=JSON.stringify(cfg),draft=agentTestConfig({id:'claude',executable:'/fixture/new',profile:'full'},cfg);
  let detected,runOptions;
  const prepared=await prepareAgentTest('claude',draft,async(fresh,configured)=>{
    detected={fresh,configured};return [{id:'claude',label:'Claude Code',available:true,path:'/fixture/resolved-new',version:'new-version',safeSupport:'best-effort'}];
  });
  const result=await testAgentConnection(prepared,{run:async options=>{runOptions=options;return {answer:'OK'};}});
  assert.equal(detected.fresh,true);assert.equal(detected.configured.executable,'/fixture/new');assert.equal(result.executable,'/fixture/new');
  assert.equal(result.path,'/fixture/resolved-new');assert.equal(result.version,'new-version');assert.equal(result.configuredProfile,'full');
  assert.equal(runOptions.profile,'safe');assert.equal(runOptions.notesDir,'');assert.equal(runOptions.resume,false);assert.equal(result.scope,'connection-only');
  assert.equal(JSON.stringify(cfg),snapshot);assert.doesNotMatch(JSON.stringify(result),/PROXY|private/);
});

await test('测试不修改配置；不将其他 Agent 的凭证传给草稿选中的 CLI',async()=>{
  const cfg={agent:{id:'codex',profile:'full',env:{SECRET:'do-not-share'},notesDir:'/private/notes'}};
  const original=JSON.stringify(cfg),prepared=await prepareAgentTest('claude',cfg,installed);
  assert.deepEqual(prepared.env,{});assert.equal(JSON.stringify(cfg),original);
  await assert.rejects(()=>prepareAgentTest('/bin/sh',cfg,installed),e=>e.code==='BAD_AGENT');
  await assert.rejects(()=>prepareAgentTest('codex',cfg,installed),e=>e.code==='NO_AGENT');
  await assert.rejects(()=>prepareAgentTest('gemini',cfg,installed),e=>e.code==='AGENT_SAFE_UNSUPPORTED');
});

await test('固定短消息、Safe、新会话、无笔记授权，成功只返回验证元数据',async()=>{
  const prepared=await prepareAgentTest('claude',{agent:{id:'claude',env:{PROXY:'test'}}},installed);
  let options;
  const result=await testAgentConnection(prepared,{run:async o=>{options=o;return {answer:'OK',sessionId:'not-exposed'};}});
  assert.equal(options.prompt,CONNECTION_PROMPT);assert.equal(options.profile,'safe');assert.equal(options.notesDir,'');
  assert.equal(options.resume,false);assert.equal(options.maxTurns,1);assert.equal(options.timeoutMs,45000);
  assert.equal(result.ok,true);assert.equal(result.scope,'connection-only');assert.equal(result.agent,'claude');
  assert.equal(JSON.stringify(result).includes('not-exposed'),false);assert.equal(JSON.stringify(result).includes('PROXY'),false);
  const argv=_argvFor('claude',{prompt:CONNECTION_PROMPT,profile:'safe',connectionTest:true,maxTurns:1}).argv;
  assert.equal(argv[argv.indexOf('--tools')+1],'');assert.ok(!argv.includes('--allowedTools'));assert.ok(!argv.includes('--add-dir'));
});

await test('桌面 DSH 连接测试能力独立于普通 Safe，不提升为 Full 或修改配置',async()=>{
  const cfg={agent:{id:'dsh',profile:'full',notesDir:'/private/notes',env:{DSH_HOME:'/profiles/desktop'}}};
  const original=JSON.stringify(cfg);
  const detect=async()=>[{id:'dsh',label:'DeepSeek Harness',version:'0.2.1-rc.2',available:true,
    safeSupport:'unsupported',connectionTestSupported:true,source:'desktop'}];
  const prepared=await prepareAgentTest('dsh',cfg,detect);
  let options;
  const result=await testAgentConnection(prepared,{run:async o=>{options=o;return {answer:'OK'};}});
  assert.equal(result.ok,true);assert.equal(options.profile,'safe');assert.equal(options.connectionTest,true);
  assert.equal(options.notesDir,'');assert.equal(options.prompt,CONNECTION_PROMPT);
  assert.equal(JSON.stringify(cfg),original);
  await assert.rejects(()=>prepareAgentTest('dsh',cfg,async()=>[{
    ...(await detect())[0],connectionTestSupported:false,
  }]),e=>e.code==='AGENT_SAFE_UNSUPPORTED');
});

await test('未完成固定回复不能报成功，登录/超时/取消给出下一步且不泄漏诊断原文',async()=>{
  const prepared=await prepareAgentTest('claude',{},installed);
  await assert.rejects(()=>testAgentConnection(prepared,{run:async()=>({answer:'Please login'})}),e=>e.code==='AGENT_TEST_RESPONSE');
  for(const code of ['AGENT_AUTH','AGENT_TIMEOUT','AGENT_PARSE','ABORTED','OTHER']){
    await assert.rejects(()=>testAgentConnection(prepared,{run:async()=>{throw Object.assign(new Error('SECRET_KEY=private'),{code});}}),e=>!e.message.includes('SECRET_KEY')&&e.code===code);
  }
});

await test('完整选择→草稿测试→保存链保留HMAC成功结果，全程不运行真实CLI或读取笔记',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'contextflow-agent-draft-flow-'));
  const dom=new JSDOM('<div id="settings"></div>',{pretendToBeVisual:true});
  const keys=['window','document','HTMLElement','Node','Event'],previous=new Map(keys.map(key=>[key,globalThis[key]]));
  for(const key of keys)globalThis[key]=dom.window[key];
  try{
    const {Settings}=await import('../src/skill/settings.js');
    const checks=new ConnectionChecks(directory,'fixture-service-secret');
    let saved={translate:{provider:'openai',baseUrl:'',model:'',apiKey:'',target:'简体中文'},explain:{backend:'llm'},
      agent:{id:'claude',executable:'/fixture/old-claude',profile:'safe',profileSource:'user',env:{TOKEN:'private-original-cli'},notesDir:''},
      sync:{backend:'markdown'},markdown:{dir:'/fixture/notes',folder:'/阅读记录'},obsidian:{vaultPath:''},siyuan:{origin:'http://127.0.0.1:6806'}};
    const rows=()=>[{id:'claude',label:'Claude Code',available:true,path:'/fixture/old-claude',version:'v1',safeSupport:'best-effort'},
      {id:'codex',label:'Codex CLI',available:true,path:saved.agent.id==='codex' ? saved.agent.executable : '/fixture/codex',version:'v2',safeSupport:'verified'}];
    const publicConfig=()=>{
      const value=structuredClone(saved);delete value.agent.env;delete value.translate.apiKey;value.translate.apiKeySet=false;value.siyuan.tokenSet=false;
      value.connectionChecks=checks.view(saved,rows());return value;
    };
    let writes=0,executions=0;
    const api={getConfig:async()=>publicConfig(),health:async()=>({capabilities:['llm.draft','agent.test','agent.test.draft','connection.checks']}),
      listFolders:async()=>({folders:[]}),detectAgents:async()=>({agents:rows(),connectionChecks:checks.view(saved,rows())}),
      testAgent:async(id,{draft})=>{
        const temporary=agentTestConfig({id,...draft},saved);
        const prepared=await prepareAgentTest(id,temporary,async(fresh,configured)=>{
          assert.equal(fresh,true);assert.deepEqual(configured.env,{});
          return rows().map(row=>row.id===id ? {...row,path:configured.executable || row.path} : row);
        });
        const ticket=checks.begin(checks.agentKey(prepared));
        const result=await testAgentConnection(prepared,{run:async options=>{executions++;assert.equal(options.prompt,CONNECTION_PROMPT);assert.equal(options.profile,'safe');assert.equal(options.notesDir,'');assert.deepEqual(options.env,{});return {answer:'OK'};}});
        checks.finish(ticket,true,result.checkedAt);return result;
      },putConfig:async patch=>{
        writes++;const next={...saved};for(const [key,value]of Object.entries(patch))next[key]={...saved[key],...value};
        if(next.agent.id!==saved.agent.id)next.agent.env={};saved=next;return publicConfig();
      }};
    const shadow=dom.window.document.getElementById('settings').attachShadow({mode:'open'}),mount=dom.window.document.createElement('div');shadow.append(mount);
    const settings=new Settings(shadow,mount,api);await settings.load();await settings.detectAgents(true);
    settings.$('s-exBackend').value='agent';settings.$('s-exBackend').dispatchEvent(new Event('change',{bubbles:true}));
    settings.$('s-agent').value='codex';settings.$('s-agent').dispatchEvent(new Event('change',{bubbles:true}));
    settings.$('s-agentExecutable').value='/fixture/custom-codex';settings.$('s-agentExecutable').dispatchEvent(new Event('input',{bubbles:true}));
    assert.equal(settings.$('s-testAgent').disabled,false);assert.equal(settings.$('s-save').disabled,true);
    await settings.testAgent();assert.equal(writes,0);assert.equal(saved.agent.id,'claude');assert.equal(settings.$('s-save').disabled,false);
    await settings.save();assert.equal(writes,1);assert.equal(executions,1);assert.equal(saved.agent.id,'codex');assert.deepEqual(saved.agent.env,{});
    assert.equal(settings.cfg.connectionChecks.agents.codex.ok,true);assert.equal(settings.agentResult().ok,true);assert.equal(settings.saving,false);assert.equal(settings.dirty,false);
    assert.doesNotMatch(readFileSync(join(directory,'connection-checks.json'),'utf8'),/private-original-cli|fixture\/custom|notes|TOKEN/);
    clearTimeout(settings.toastTimer);clearTimeout(settings.messageTimer);
  }finally{
    for(const key of keys){if(previous.get(key)===undefined)delete globalThis[key];else globalThis[key]=previous.get(key);}
    dom.window.close();rmSync(directory,{recursive:true,force:true});
  }
});

await test('折叠保持表单节点、文字状态与 aria，减弱动态效果时不创建动画',()=>{
  const dom=new JSDOM('<details><summary>配置<span data-disclosure-label></span></summary><input value="draft"></details>',{pretendToBeVisual:true});
  const details=dom.window.document.querySelector('details'),input=details.querySelector('input');
  const controller=wireDisclosure(details);const summary=details.firstElementChild;
  summary.click();assert.equal(details.open,true);assert.equal(summary.getAttribute('aria-expanded'),'true');
  assert.equal(summary.querySelector('span').textContent,'收起');input.focus();summary.click();
  assert.equal(details.open,false);assert.equal(dom.window.document.activeElement,summary);
  assert.equal(details.querySelector('input'),input);assert.equal(input.value,'draft');assert.equal(controller.body.inert,true);
  details.open=true;controller.sync();assert.equal(summary.querySelector('span').textContent,'收起');
  dom.window.matchMedia=()=>({matches:true});
  controller.body.animate=()=>{throw new Error('减弱动态效果时不能运行动画');};
  summary.click();assert.equal(details.open,false);
});

await test('快速连续切换从中间高度反向，旧动画结束不能覆盖新状态',async()=>{
  const dom=new JSDOM('<details><summary>配置<span data-disclosure-label></span></summary><p>内容</p></details>');
  const details=dom.window.document.querySelector('details');const controller=wireDisclosure(details);const runs=[];
  controller.body.getBoundingClientRect=()=>({height:42});
  controller.body.animate=(frames)=>{let finish,reject;const animation={frames,finished:new Promise((yes,no)=>{finish=yes;reject=no;}),cancel:()=>reject(new Error('canceled')),finish:()=>finish()};runs.push(animation);return animation;};
  details.firstElementChild.click();details.firstElementChild.click();details.firstElementChild.click();
  assert.equal(runs[1].frames[0].height,'42px');runs[0].finish();runs[1].finish();await Promise.resolve();
  assert.equal(details.open,true);runs[2].finish();await Promise.resolve();assert.equal(details.open,true);
  assert.equal(details.dataset.expanded,'true');assert.equal(controller.body.inert,false);
});
console.log(`\n${pass} 项通过`);
