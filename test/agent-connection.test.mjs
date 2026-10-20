import assert from 'node:assert/strict';
import { prepareAgentTest, testAgentConnection, CONNECTION_PROMPT } from '../server/agent-test.mjs';
import { _argvFor } from '../server/agent.mjs';
import { JSDOM } from 'jsdom';
import { wireDisclosure } from '../src/core/disclosure.js';

let pass=0;
async function test(name,fn){try{await fn();pass++;console.log(`  ok   ${name}`);}catch(error){process.exitCode=1;console.error(`  FAIL ${name}\n${error.stack}`);}}
const installed=async()=>[{id:'claude',label:'Claude Code',version:'test-version',available:true,safeSupport:'best-effort'},
  {id:'gemini',label:'Gemini CLI',available:true,safeSupport:'unsupported'}];
console.log('Agent 连接验证与可逆折叠\n');

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

await test('未完成固定回复不能报成功，登录/超时/取消给出下一步且不泄漏诊断原文',async()=>{
  const prepared=await prepareAgentTest('claude',{},installed);
  await assert.rejects(()=>testAgentConnection(prepared,{run:async()=>({answer:'Please login'})}),e=>e.code==='AGENT_TEST_RESPONSE');
  for(const code of ['AGENT_AUTH','AGENT_TIMEOUT','AGENT_PARSE','ABORTED','OTHER']){
    await assert.rejects(()=>testAgentConnection(prepared,{run:async()=>{throw Object.assign(new Error('SECRET_KEY=private'),{code});}}),e=>!e.message.includes('SECRET_KEY')&&e.code===code);
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
