import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import * as store from '../src/core/offline-store.js';
import { libraryArticles, searchLibrary, safeReadingUrl, encodeReadingBackup, decodeReadingBackup, BACKUP_FORMAT } from '../src/core/reading-library.js';

const ev=(id,over={})=>({id,urlKey:'https://article.test/a',url:'https://article.test/a',title:'研究与学习',action:'highlight',
  text:'原文内容',value:null,color:'yellow',anchor:{exact:'原文内容',prefix:'前面',suffix:'后面',start:5,end:9},createdAt:100,updatedAt:200,mutationId:'m-'+id,...over});
let pass=0;
const t=async(name,fn)=>{try{await fn();console.log(`  ok   ${name}`);pass++;}catch(error){console.error(`  FAIL ${name}\n${error.stack}`);process.exitCode=1;}};
let backup,image;
await t('跨文章分组与多词搜索覆盖原文、问题、补充和标题；同文不同锚点不丢记录',()=>{
  const rows=libraryArticles([ev('a'),ev('b',{action:'explain',extra:{question:'怎么使用',supplement:'独立思考'},value:'LLM 解释'}),
    ev('c',{urlKey:'b',url:'javascript:alert(1)',title:'别的文章',updatedAt:300,action:'note',value:'我的思考'}),ev('d',{deletedAt:1000})]);
  assert.equal(rows.length,2);assert.equal(rows[1].events.length,2);
  assert.equal(searchLibrary(rows,'研究 思考','explain').length,1);assert.equal(searchLibrary(rows,'原文 使用').length,1);
  assert.equal(searchLibrary(rows,'LLM','note').length,0);assert.equal(rows[0].url,'');
  assert.equal(safeReadingUrl('https://user:password@article.test'),'');
});
await t('图片和历史回答随完整备份往返，不备份密钥、配置、任务或缓存正文',async()=>{
  image=await store.saveOfflineAsset(new Blob(['library-test-png'],{type:'image/png'}),{name:'截图.png'});
  const e=ev('backed-up',{action:'comment',parentId:'parent',value:`想法 ![原文图](contextflow-asset:${image.id})`,
    apiKey:'top-secret',extra:{supplement:'补充',apiKey:'nested-secret',jobId:'private-job',sessionId:'private-session',history:[{at:1,value:'旧回答'}]}});
  backup=await encodeReadingBackup({events:[e,ev('dead',{deletedAt:5})],assets:[image],config:{apiKey:'config-secret'},articles:[{text:'private-full-article'}]},'0.3.3');
  assert.doesNotMatch(backup,/top-secret|nested-secret|private-job|private-session|config-secret|private-full-article/);
  const decoded=await decodeReadingBackup(backup);
  assert.equal(decoded.events.length,1);assert.equal(decoded.articleCount,1);assert.equal(decoded.assets.length,1);
  assert.equal(await decoded.assets[0].blob.text(),'library-test-png');assert.equal(decoded.events[0].extra.history[0].value,'旧回答');
  assert.equal(decoded.events[0].parentId,'parent');assert.equal(decoded.events[0].anchor.start,5);
});
await t('缺图、图片哈希损坏、重复 ID、版本和字段错误被拒绝，不静默导入不完整文件',async()=>{
  const raw=JSON.parse(backup);
  await assert.rejects(()=>decodeReadingBackup(JSON.stringify({...raw,version:9})),/版本/);
  await assert.rejects(()=>decodeReadingBackup('{wrong'),/JSON/);
  await assert.rejects(()=>decodeReadingBackup(JSON.stringify({...raw,assets:[]})),/缺少引用/);
  await assert.rejects(()=>decodeReadingBackup(JSON.stringify({...raw,assets:[{...raw.assets[0],data:btoa('corrupt')}]})),/校验失败/);
  await assert.rejects(()=>decodeReadingBackup(JSON.stringify({...raw,events:[raw.events[0],{...raw.events[0],urlKey:'other'}]})),/重复/);
  await assert.rejects(()=>decodeReadingBackup(JSON.stringify({...raw,events:[{...raw.events[0],value:{malicious:true}}]})),/格式/);
  await assert.rejects(()=>encodeReadingBackup({events:raw.events,assets:[]}),/图片尚未保存/);
});
await t('未完成 AI 请求恢复为需手动重试，不恢复 job/session；导出不修改源对象',async()=>{
  const pending=ev('pending',{action:'explain',extra:{status:'running',jobId:'unsafe-job',question:'解释',regenerating:true}});
  const serialized=await encodeReadingBackup({events:[pending],assets:[]});
  const decoded=await decodeReadingBackup(serialized);
  assert.equal(decoded.events[0].extra.status,'canceled');assert.equal(decoded.events[0].extra.jobId,null);
  assert.equal(pending.extra.status,'running');assert.equal(pending.extra.jobId,'unsafe-job');
});
await t('恢复原子补充新记录，保留较新的本地内容与 tombstone，不复活被删除的父批注',async()=>{
  await store.saveOfflineEvents([ev('existing',{value:'当前编辑',updatedAt:900}),ev('deleted-parent',{deletedAt:800})],{queue:false});
  const decoded=await decodeReadingBackup(backup);
  const result=await store.restoreReadingLibrary({events:[ev('existing',{value:'旧备份'}),ev('deleted-parent'),ev('new-child',{parentId:'deleted-parent'}),...decoded.events],assets:decoded.assets});
  assert.deepEqual(result,{added:1,skipped:3});
  const rows=(await store.readingLibrarySnapshot()).events;
  assert.equal(rows.find(e=>e.id==='existing').value,'当前编辑');assert.equal(rows.find(e=>e.id==='deleted-parent').deletedAt,800);
  assert.equal(rows.some(e=>e.id==='new-child'),false);assert.ok(rows.some(e=>e.id==='backed-up'));
  assert.equal(await store.operationCount(),1,'只为新导入的阅读内容创建保存操作，不创建 AI 任务或笔记写入');
  const repeated=await store.restoreReadingLibrary(decoded);assert.deepEqual(repeated,{added:0,skipped:1});
});
await t('恢复写入失败时，记录、图片和待保存操作整体回滚',async()=>{
  const before=(await store.readingLibrarySnapshot()).events.length;
  await assert.rejects(()=>store.restoreReadingLibrary({events:[ev('should-rollback')],assets:[{blob:new Blob(['broken'])}]}));
  assert.equal((await store.readingLibrarySnapshot()).events.length,before);
  assert.equal(await store.operationCount(),1);
});
await t('备份快照只读取有效记录引用的图片，不搬入孤立或仅已删除记录的附件',async()=>{
  const orphan=await store.saveOfflineAsset(new Blob(['unused-image'],{type:'image/png'}));
  await store.saveOfflineEvents([ev('dead-image',{deletedAt:1000,value:`![已删除](contextflow-asset:${orphan.id})`})],{queue:false});
  const snapshot=await store.readingLibrarySnapshot({withAssets:true});
  assert.deepEqual(snapshot.assets.map(a=>a.id),[image.id]);
});

const dom=new JSDOM('<!doctype html><body><div id="library"></div></body>',{pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','Node','Event'])globalThis[key]=dom.window[key];
globalThis.innerWidth=1200;
const {ReadingLibrary}=await import('../src/ext/library.js');
const make=options=>{document.body.innerHTML='<div id="library"></div>';return new ReadingLibrary(document.getElementById('library'),options);};
await t('阅读库空态、搜索和翻页可用；恶意标题/正文只作为文字；非法链接不导航',async()=>{
  const events=Array.from({length:25},(_,i)=>ev('ui-'+i,{urlKey:'ui-'+i,title:`标题 ${i}`,value:'笔记关键词',updatedAt:100+i}));
  events.push(ev('xss',{urlKey:'xss',url:'javascript:alert(1)',title:'<img src=x onerror=alert(1)>',action:'note',value:'<script>bad()</script>',updatedAt:1000}));
  const ui=make({snapshot:async()=>({events,assets:[]})});await ui.refresh();
  assert.equal(ui.$('library-list').children.length,20);assert.equal(ui.$('library-pager').hidden,false);
  assert.equal(ui.$('library-preview-tools').querySelector('a'),null);assert.equal(ui.sh.querySelector('script,img[onerror]'),null);
  ui.$('library-next').click();assert.equal(ui.$('library-list').children.length,6);
  ui.$('library-query').value='笔记关键词 标题 1';ui.$('library-query').dispatchEvent(new Event('input'));
  assert.equal(ui.page,0);assert.match(ui.$('library-results').textContent,/12 \/ 26/);
  ui.$('library-query').value='无匹配';ui.$('library-query').dispatchEvent(new Event('input'));
  assert.match(ui.$('library-list').textContent,/没有匹配/);
  const empty=make({snapshot:async()=>({events:[],assets:[]})});await empty.refresh();assert.match(empty.$('library-list').textContent,/第一条批注/);
});
await t('选择文件只预览，取消不写入；确认恢复先等待编辑保存，失败保留可重试的预览',async()=>{
  let restores=0,flushes=0;
  const ui=make({snapshot:async()=>({events:[],assets:[]}),flush:async()=>{flushes++;},restore:async()=>{restores++;throw new Error('存储配额不足');}});
  const file={size:backup.length,name:'reading.json',text:async()=>backup};
  await ui.action(()=>ui.inspectFile(file));assert.equal(restores,0);assert.equal(ui.$('library-restore-preview').hidden,false);
  assert.equal(ui.sh.activeElement,ui.$('library-restore'));
  ui.cancelRestore();assert.equal(restores,0);assert.equal(ui.pendingRestore,null);
  await ui.action(()=>ui.inspectFile(file));await ui.action(()=>ui.restore());
  assert.equal(restores,1);assert.equal(flushes,1);assert.ok(ui.pendingRestore);assert.equal(ui.$('library-restore-preview').hidden,false);
  assert.equal(ui.$('library-notice').getAttribute('role'),'alert');assert.match(ui.$('library-notice').textContent,/配额不足/);
  assert.equal(ui.$('library-restore').disabled,false);
});
await t('备份先等待所有编辑保存；保存失败不生成文件且不清空数据',async()=>{
  let downloads=0;
  const ui=make({flush:async()=>{throw new Error('网页尚未保存');},snapshot:async()=>{throw new Error('不应读取');}});
  ui.download=()=>downloads++;await ui.action(()=>ui.backup());assert.equal(downloads,0);
  assert.match(ui.$('library-notice').textContent,/尚未保存/);assert.equal(ui.$('library-backup').disabled,false);
});
console.log(`\n${pass} 项通过`);
