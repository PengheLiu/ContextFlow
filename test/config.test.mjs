// Agent profile 配置迁移与完整权限确认。
import assert from 'node:assert/strict';
import { migrate, fullAckValid, publicView, AGENT_PROFILE_VERSION, FULL_WARNING } from '../server/config.mjs';
import { createHash } from 'node:crypto';

let pass=0;const t=(n,f)=>{try{f();console.log(`  ok   ${n}`);pass++}catch(e){console.log(`  FAIL ${n}\n       ${e.message}`);process.exitCode=1}};
const wh=()=>createHash('sha256').update(FULL_WARNING).digest('hex').slice(0,16);
console.log('Agent profile 配置迁移\n');

t('新用户/未配 agent 默认 safe',()=>{
 const c=migrate({}); assert.equal(c.agent.profile,'safe'); assert.equal(c.agent.profileSource,'new-default');
});
t('已有 agent 且没有 profile → legacy full',()=>{
 const c=migrate({agent:{id:'claude'}});assert.equal(c.agent.profile,'full');assert.equal(c.agent.profileSource,'legacy-migrated');
});
t('迁移幂等',()=>{
 const a=migrate({agent:{id:'claude'}}); const b=migrate(a); assert.deepEqual(b,a);
});
t('未知 profile fail closed 到 safe',()=>assert.equal(migrate({agent:{id:'claude',profile:'god'}}).agent.profile,'safe'));
t('legacy full 保持可用但不需要伪造 ack',()=>assert.equal(fullAckValid(migrate({agent:{id:'claude'}}).agent),true));
t('user full 无 ack 无效',()=>assert.equal(fullAckValid({id:'claude',profile:'full',profileSource:'user'}),false));
t('有效 ack 绑定 agent 与 warning version',()=>{
 const a={id:'claude',profile:'full',profileSource:'user',fullAccessAcknowledgement:{version:AGENT_PROFILE_VERSION,agentId:'claude',acceptedAt:Date.now(),warningHash:wh()}};
 assert.equal(fullAckValid(a),true); assert.equal(fullAckValid({...a,id:'codex'}),false);
});
t('warning hash 不匹配则 ack 失效',()=>{
 const a={id:'claude',profile:'full',profileSource:'user',fullAccessAcknowledgement:{version:AGENT_PROFILE_VERSION,agentId:'claude',acceptedAt:1,warningHash:'old'}};
 assert.equal(fullAckValid(a),false);
});
t('迁移不泄漏/删除既有其他配置',()=>{
 const c=migrate({translate:{model:'m'},agent:{id:'claude',notesDir:'/n'}});assert.equal(c.translate.model,'m');assert.equal(c.agent.notesDir,'/n');
});
t('legacy full 对外显示未主动确认，并给 UI 生成确认所需元数据',()=>{
 const cfg={
  explain:{backend:'agent'},agent:migrate({agent:{id:'claude'}}).agent,
  translate:{provider:'openai',baseUrl:'',model:'',target:'简体中文',thinking:false,chunkChars:5000,tailChars:1000,apiKey:''},
  sync:{backend:'markdown'},obsidian:{vaultPath:'',folder:'/'},markdown:{dir:'/tmp',folder:'/'},
  siyuan:{origin:'',notebookId:'',docPathPrefix:'/',token:''},allowAnyOrigin:false,requireToken:false,
 };
 const v=publicView(cfg);assert.equal(v.agent.profileSource,'legacy-migrated');assert.equal(v.agent.fullAccessAcknowledged,false);
 assert.equal(v.agent.fullWarningVersion,AGENT_PROFILE_VERSION);assert.equal(v.agent.fullWarningHash,wh());
});
console.log(`\n${pass} 项通过`);
