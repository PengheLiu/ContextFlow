import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadingStatus } from '../server/reading-status.mjs';
import { productState } from '../desktop/ui/product-state.js';

const identity=Symbol.for('contextflow.agent-execution-identity');
const cfg={explain:{backend:'agent'},translate:{},agent:{id:'codex',executable:'',profile:'safe',notesDir:'/fixture/notes',env:{}},sync:{backend:'markdown'}};
const installed={id:'codex',available:true,path:'/fixture/resolved/codex',version:'1.0',identity:'opaque-cli-file-1'};
const answer={via:'agent:codex',answer:'fixture answer',[identity]:installed};
test('Agent answer receipts require the actual resolved program and cannot follow PATH, version or file replacement',()=>{
  const root=mkdtempSync(join(tmpdir(),'cf-agent-receipt-'));
  try{
    const status=new ReadingStatus(root,'fixture-service-key',{now:()=>100});
    assert.equal(status.answer(cfg,{via:'agent:codex',answer:'unbound'}),false,'a configured label alone is not execution evidence');
    assert.equal(status.answer(cfg,answer),true);assert.equal(status.view(cfg,[installed]).ai.verified,true);
    for(const patch of [{path:'/fixture/other/codex'},{version:'2.0'},{identity:'opaque-cli-file-2'},{available:false}])
      assert.equal(status.view(cfg,[{...installed,...patch}]).ai.verified,false,JSON.stringify(patch));
    assert.equal(status.view(cfg,[]).ai.verified,false,'unavailable or unresolved CLI cannot inherit an earlier answer');
    const copy={...answer,question:'copy'};
    assert.ok(copy[identity]);assert.doesNotMatch(JSON.stringify(copy),/fixture\/resolved|opaque-cli-file/,'server-only execution identity is not serialized into model results');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a newer failed connection test defeats old answers, while a later real answer can validate again',()=>{
  const root=mkdtempSync(join(tmpdir(),'cf-agent-failed-check-'));
  try{
    let now=100;const status=new ReadingStatus(root,'fixture-service-key',{now:()=>now});status.answer(cfg,answer);
    const failed={agents:{codex:{ok:false,checkedAt:200}}};
    assert.equal(status.view(cfg,[installed],failed).ai.verified,false);
    now=300;status.answer(cfg,answer);assert.equal(status.view(cfg,[installed],failed).ai.verified,true);
    const snapshot={service:{state:'running'},readingStatus:{ai:{verified:true,lastAnswerAt:100}}};
    const config={...cfg,connectionChecks:failed};
    assert.equal(productState(snapshot,config).ai.ok,false,'desktop must not let stale actual-use success mask a newer failed test');
    assert.notEqual(productState(snapshot,config).ai.label,'已完成网页回答');
    snapshot.readingStatus.ai.lastAnswerAt=300;assert.equal(productState(snapshot,config).ai.ok,true);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('real Agent connection failures invalidate older answer and test success, but cancellation does not',()=>{
  const root=mkdtempSync(join(tmpdir(),'cf-agent-failed-answer-'));
  try{
    let now=100;const status=new ReadingStatus(root,'fixture-service-key',{now:()=>now});status.answer(cfg,answer);
    const canceled={code:'ABORTED',[identity]:installed};assert.equal(status.agentFailure(cfg,canceled),false);
    assert.equal(status.view(cfg,[installed]).ai.verified,true);
    now=300;assert.equal(status.agentFailure(cfg,{code:'AGENT_AUTH',[identity]:installed}),true);
    const snapshot={service:{state:'running'},readingStatus:status.view(cfg,[installed])};
    const config={...cfg,connectionChecks:{agents:{codex:{ok:true,checkedAt:200}}}};
    assert.equal(productState(snapshot,config).ai.ok,false);assert.equal(productState(snapshot,config).ai.label,'需要重新验证');
    config.connectionChecks.agents.codex.checkedAt=400;assert.equal(productState(snapshot,config).ai.ok,true,'a newer successful explicit test can recover');
    now=500;status.answer(cfg,answer);assert.equal(status.view(cfg,[installed]).ai.verified,true);
  }finally{rmSync(root,{recursive:true,force:true});}
});
