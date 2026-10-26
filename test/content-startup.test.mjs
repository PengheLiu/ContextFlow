import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContentStartup, startupFailureNotice } from '../src/ext/startup.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const tick=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
function fixture({initialize,blocked=()=>null,supported=()=>true}={}) {
  const dom=new JSDOM('<!doctype html><body><h1>Host article</h1><p id="draft" contenteditable>keep this host draft</p></body>',{url:'https://article.test/read',pretendToBeVisual:true});
  for(const key of ['window','document','Node','HTMLElement','Event'])globalThis[key]=dom.window[key];
  globalThis.location=dom.window.location;globalThis.innerWidth=1200;globalThis.innerHeight=800;
  let boots=0,help=0,unblocks=0,controller;
  const notice=startupFailureNotice({retry:()=>controller.retry(),help:async()=>{help++;throw new Error('private-token must never be displayed');}});
  controller=createContentStartup({initialize,start:()=>{boots++;return {fixture:true};},blocked,supported,
    showBlocked:()=>unblocks++,showError:notice.show,clearError:notice.clear});
  return {dom,controller,notice,get boots(){return boots;},get help(){return help;},get unblocks(){return unblocks;},
    error:()=>dom.window.document.querySelector('[data-contextflow="startup-error"]')?.shadowRoot,
    close(){notice.clear();dom.window.close();}};
}

test('failed private initialization is fail-closed; only an explicit icon request reveals a safe actionable notice',async()=>{
  let calls=0,fail=true;
  const f=fixture({initialize:async()=>{calls++;if(fail)throw new Error('private-token https://private.test/secret');}});
  try{
    await f.controller.start();assert.equal(f.boots,0);assert.equal(f.controller.ready,false);assert.equal(f.error(),undefined,'unknown disabled preferences must stay quiet');
    f.controller.show();assert.ok(f.error());assert.equal(f.error().querySelector('[role=alert]')!==null,true);
    assert.match(f.error().textContent,/本页批注暂不可用/);assert.match(f.error().textContent,/没有确认任何新内容已保存/);
    assert.doesNotMatch(f.error().textContent,/private-token|private\.test/);
    f.error().querySelector('.help').click();await tick();assert.equal(f.help,1);
    assert.match(f.error().textContent,/扩展程序选项.*帮助与诊断/);assert.doesNotMatch(f.error().textContent,/private-token/);
    assert.equal(f.dom.window.document.querySelector('#draft').textContent,'keep this host draft');assert.equal(f.dom.window.location.href,'https://article.test/read');
    fail=false;f.error().querySelector('.retry').click();await tick();
    assert.equal(calls,2);assert.equal(f.boots,1);assert.equal(f.controller.ready,true);assert.equal(f.error(),undefined);
    assert.equal(f.dom.window.document.querySelector('#draft').textContent,'keep this host draft');
  }finally{f.close();}
});
test('retry re-reads suppression before boot and cannot silently reactivate a disabled page',async()=>{
  let fail=true,scope=null;
  const f=fixture({initialize:async()=>{if(fail)throw new Error('offline');scope='site';},blocked:()=>scope});
  try{
    await f.controller.start();f.controller.show();assert.ok(f.error());
    fail=false;await f.controller.retry();assert.equal(f.boots,0);assert.equal(f.unblocks,1);assert.equal(f.controller.ready,true);assert.equal(f.error(),undefined);
    f.controller.show();assert.equal(f.boots,0);assert.equal(f.unblocks,2);
    assert.equal(f.dom.window.location.href,'https://article.test/read');
  }finally{f.close();}
});
test('unsupported pages do not initialize storage or paint recovery UI, and repeated pending retries coalesce',async()=>{
  let calls=0;const unsupported=fixture({supported:()=>false,initialize:async()=>calls++});
  try{await unsupported.controller.start();unsupported.controller.show();await unsupported.controller.retry();assert.equal(calls,0);assert.equal(unsupported.error(),undefined);}finally{unsupported.close();}
  let release;const f=fixture({initialize:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  try{
    const a=f.controller.start(),b=f.controller.retry();await tick();assert.equal(calls,1);assert.equal(f.controller.ready,false);
    release();await Promise.all([a,b]);assert.equal(f.boots,1);
    await f.controller.retry();assert.equal(calls,1,'successful initialization is not replayed or booted twice');
  }finally{f.close();}
});
test('actual extension entry reports failed flush honestly, routes help safely, and boots only after an explicit successful retry',async()=>{
  const result=await build({entryPoints:[fileURLToPath(new URL('../src/ext/app.js',import.meta.url))],bundle:true,write:false,
    format:'iife',platform:'browser',target:'chrome111',plugins:[{name:'isolated-boot-fixture',setup(builder){
      builder.onResolve({filter:/\/skill\/main\.js$/},()=>({path:'fake-reading-app',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export function boot(){window.boots++;return {get ready(){return Promise.resolve(window.readingReady)},togglePanel(){window.toggles++},async flushForNavigation(){window.flushes++;if(window.flushFailure)throw new Error('isolated failure')},panel:{renderStatus(){}}}}`,loader:'js'}));
    }}]});
  const dom=new JSDOM('<!doctype html><body><p id="draft" contenteditable>host draft is retained</p></body>',
    {url:'https://entry.test/article',pretendToBeVisual:true,runScripts:'outside-only'});
  const win=dom.window,messages=[];let handler,fail=true;
  Object.assign(win,{boots:0,toggles:0,flushes:0,chrome:{runtime:{lastError:null,
    sendMessage(message,reply){messages.push(message);reply(message.type==='cf-ui-snapshot' ? fail ? {ok:false,error:'PRIVATE_KEY is not public'} : {ok:true,value:{}} : {ok:true,value:true});},
    onMessage:{addListener(fn){handler=fn;}}}}});
  win.fetch=()=>{throw new Error('startup must not call a model or service');};
  try{
    win.eval(result.outputFiles[0].text);await tick();assert.equal(win.boots,0);
    let flushed;handler({type:'cf-flush-edits'}, {},reply=>{flushed=reply;});assert.deepEqual(JSON.parse(JSON.stringify(flushed)),{contextflow:true,ok:false});
    handler({type:'cf-toggle'});const sh=win.document.querySelector('[data-contextflow="startup-error"]').shadowRoot;
    assert.doesNotMatch(sh.textContent,/PRIVATE_KEY/);assert.match(sh.textContent,/暂不可用/);
    sh.querySelector('.help').click();await tick();assert.ok(messages.some(message=>message.type==='cf-open-settings' && message.view==='support'));
    assert.equal(messages.some(message=>['cf-fetch','cf-offline','cf-ui-write'].includes(message.type)),false,'no AI, notes, preference or record writes on failed startup');
    fail=false;sh.querySelector('.retry').click();await tick();assert.equal(win.boots,1);
    handler({type:'cf-toggle'});assert.equal(win.toggles,1,'icon uses the route-guarded app facade');
    handler({type:'cf-flush-edits'}, {},reply=>{flushed=reply;});await tick();assert.equal(flushed.ok,true);assert.equal(win.flushes,1);
    win.readingReady=false;handler({type:'cf-flush-edits'}, {},reply=>{flushed=reply;});await tick();assert.equal(flushed.ok,false);assert.equal(win.flushes,1,'failed article initialization cannot confirm a saved backup');
    win.readingReady=true;win.flushFailure=true;handler({type:'cf-flush-edits'}, {},reply=>{flushed=reply;});await tick();assert.equal(flushed.ok,false);assert.equal(win.flushes,2,'a failed durable local save cannot confirm a saved backup');
    assert.equal(win.document.querySelector('#draft').textContent,'host draft is retained');assert.equal(win.location.href,'https://entry.test/article');
  }finally{dom.window.close();}
});
