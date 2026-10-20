import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir=mkdtempSync(join(tmpdir(),'contextflow-queued-config-'));
let service,releaseFirst,enteredFirst;
const firstEntered=new Promise(resolve=>{enteredFirst=resolve;});
const requests=[];
const upstream=createServer(async(req,res)=>{
  let source='';for await(const chunk of req)source+=chunk;
  const body=JSON.parse(source);requests.push({model:body.model,auth:req.headers.authorization});
  if(requests.length===1){enteredFirst();await new Promise(resolve=>{releaseFirst=resolve;});}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'A controlled answer'}}]}));
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  await listen(upstream);const modelBase=`http://127.0.0.1:${upstream.address().port}`;
  const reservation=createServer();await listen(reservation);const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  writeFileSync(join(dir,'config.json'),JSON.stringify({port,requireToken:true,token:'snapshot-fixture',
    translate:{provider:'openai',baseUrl:modelBase,model:'submitted-model',apiKey:'submitted-key'},explain:{backend:'llm'}}));
  service=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,CONTEXTFLOW_DIR:dir,ANTHROPIC_API_KEY:''},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  const call=async(path,body)=>{
    const r=await fetch(base+path,{method:body ? 'POST' : 'GET',headers:{'Content-Type':'application/json','X-ContextFlow':'1',Authorization:'Bearer snapshot-fixture'},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(10000)});
    const json=await r.json();assert.ok(r.ok,JSON.stringify(json));return json;
  };
  for(let i=0;i<100;i++){try{await call('/health');break;}catch{if(i===99)throw new Error('Service not ready');await wait(50);}}
  const first=await call('/explain',{text:'first',question:'hold',async:true,fresh:true});await firstEntered;
  const second=await call('/explain',{text:'second',question:'queued',async:true,fresh:true});assert.equal(second.job.status,'queued');
  await call('/article',{urlKey:'summary-fixture',title:'Summary',url:'https://example.org',text:'Controlled article for summary. '.repeat(30)});
  const summary=await call('/summary',{urlKey:'summary-fixture',async:true,fresh:true});assert.equal(summary.job.status,'queued');
  await call('/config',{translate:{model:'new-model',apiKey:'new-key'}});
  releaseFirst();
  for(const job of [first,second,summary]){
    for(let i=0;i<200;i++){const state=await call('/jobs/'+job.job.id);if(state.job.status==='done')break;
      assert.notEqual(state.job.status,'error',JSON.stringify(state.job.error));if(i===199)throw new Error('Job did not finish');await wait(20);}
  }
  assert.equal(requests.length,3);for(const row of requests)assert.deepEqual(row,{model:'submitted-model',auth:'Bearer submitted-key'});
  await call('/explain',{text:'after-change',question:'new',fresh:true});
  assert.deepEqual(requests[3],{model:'new-model',auth:'Bearer new-key'});
  console.log('排队配置快照：解释 / 速览使用提交时的模型与凭据；配置变更仅影响新任务，不切换既有任务目标');
} finally {
  releaseFirst?.();
  if(service && service.exitCode===null){service.kill();await once(service,'exit');}
  await new Promise(resolve=>upstream.close(resolve));rmSync(dir,{recursive:true,force:true});
}
