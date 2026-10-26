import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ServiceManager } from '../desktop/service.mjs';
import { terminateTree } from '../server/platform.mjs';
import { productState } from '../desktop/ui/product-state.js';

test('isolated core binds real Agent answers to resolved CLI files; newer auth failures and replacements invalidate readiness',
  {skip:process.platform==='win32' || /\s/.test(process.execPath),timeout:20000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'cf-agent-core-')),data=join(root,'data'),bin=join(root,'bin'),mode=join(root,'mode');
  mkdirSync(data);mkdirSync(bin);writeFileSync(mode,'ok');let service;
  const executable=join(bin,'claude');
  const program=version=>`#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0)}
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 const fail=fs.readFileSync(${JSON.stringify(mode)},'utf8').trim()==='auth';
 console.log(JSON.stringify({type:'result',subtype:fail?'error_auth':'success',is_error:fail,result:fail?'Not logged in':input.includes('Connection check only.')?'OK':'isolated agent answer',session_id:'fixture-session',num_turns:1}));
});\n`;
  for(const name of ['claude','codex','dsh','gemini']){const path=join(bin,name);writeFileSync(path,program('fixture-v1'));chmodSync(path,0o755);}
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  writeFileSync(join(data,'config.json'),JSON.stringify({port,token:'fixture-core-token',requireToken:true,
    explain:{backend:'agent'},agent:{id:'claude',executable:'',profile:'safe',notesDir:'',env:{}},translate:{chunkChars:0},
    sync:{backend:'markdown'},markdown:{dir:join(root,'notes'),folder:'/reading'}}));
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/(?:TOKEN|API.?KEY|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|AUTH)/i.test(key) &&
    !/^(?:CONTEXTFLOW_|CODEX_|DSH_|CLAUDE_|ANTHROPIC_|OPENAI_|GEMINI_)/.test(key) &&
    !['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','ELECTRON_RUN_AS_NODE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].includes(key)));
  Object.assign(environment,{PATH:bin,HOME:root,CODEX_HOME:join(root,'codex-home'),DSH_HOME:join(root,'dsh-home'),CONTEXTFLOW_DSH_BIN:join(bin,'dsh')});
  try{
    service=new ServiceManager({paths:{data,logs:join(root,'logs')},runtime:process.execPath,
      core:fileURLToPath(new URL('..',import.meta.url)),secretKey:randomBytes(32).toString('base64'),terminateTree,environment});
    await service.start();assert.equal(service.state,'running',service.message);
    const request=async(path,body)=>{
      const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?'GET':'POST',
        headers:{'Content-Type':'application/json','X-ContextFlow':'1',Authorization:`Bearer ${service.token}`},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});
      const value=await response.json();assert.ok([200,202].includes(response.status),JSON.stringify(value));return value;
    };
    const frame=()=>request('/desktop/state');
    const job=async(path,body)=>{
      let {job}=await request(path,body);const deadline=Date.now()+5000;
      while(['queued','running'].includes(job.status) && Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));({job}=await request(`/jobs/${job.id}`));}
      return job;
    };
    const explain=()=>job('/explain',{text:'A public fixture passage',question:'Explain',urlKey:'agent-readiness-fixture',fresh:true});
    let current=await frame();assert.equal(current.health.readingStatus.ai.verified,false);
    let result=await explain();assert.equal(result.status,'done',JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result),/cf-agent-core-|opaque-cli|fixture-v1/,'private execution metadata stays server-side');
    current=await frame();assert.equal(current.health.readingStatus.ai.verified,true);

    // The configured string is still empty/PATH; replacing the real program
    // must invalidate both answer/test receipts without the 10-minute TTL.
    writeFileSync(executable,program('fixture-v2'));const changed=new Date(Date.now()+2000);utimesSync(executable,changed,changed);
    current=await frame();assert.equal(current.configuration.agent.executable,'');assert.equal(current.health.readingStatus.ai.verified,false);
    result=await explain();assert.equal(result.status,'done',JSON.stringify(result));
    assert.equal((await frame()).health.readingStatus.ai.verified,true);
    result=await job('/agents/test',{id:'claude',profile:'safe'});assert.equal(result.status,'done',JSON.stringify(result));
    assert.equal((await frame()).configuration.connectionChecks.agents.claude.ok,true);

    // An auth failure in a real answering task must defeat older test success.
    writeFileSync(mode,'auth');result=await explain();assert.equal(result.status,'error');
    current=await frame();assert.equal(current.health.readingStatus.ai.verified,false);
    assert.equal(productState({service:{state:'running'},readingStatus:current.health.readingStatus},current.configuration).ai.ok,false);
    result=await job('/agents/test',{id:'claude',profile:'safe'});assert.equal(result.status,'error');
    current=await frame();assert.equal(current.configuration.connectionChecks.agents.claude.ok,false);
    assert.equal(current.health.readingStatus.ai.verified,false);
    writeFileSync(mode,'ok');result=await explain();assert.equal(result.status,'done');
    current=await frame();assert.equal(current.health.readingStatus.ai.verified,true,'a later real answer can recover without rewriting config');
    for(const file of ['reading-status.json','connection-checks.json'])assert.doesNotMatch(readFileSync(join(data,file),'utf8'),/fixture-v|cf-agent-core-|isolated agent answer/);
  }finally{await service?.stop().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
