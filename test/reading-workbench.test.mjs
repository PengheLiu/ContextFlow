import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { groupRecords, matchesRecord } from '../src/core/reading-records.js';

const dom = new JSDOM('<!doctype html><body><p>Source text</p></body>', { url: 'https://example.com/workbench', pretendToBeVisual: true });
for (const key of ['window','document','location','localStorage','HTMLElement','Node','NodeFilter','Range','getComputedStyle']) global[key] = dom.window[key];
Object.assign(global, { indexedDB, IDBKeyRange, innerWidth: 1400, innerHeight: 900,
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window) });
const { Panel } = await import('../src/skill/panel.js');
const { App } = await import('../src/skill/main.js');
const api = await import('../src/core/api.js');
const offline = await import('../src/core/offline-store.js');
const { submit, cancel, get, stats, _reset } = await import('../server/jobs.mjs');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`  FAIL ${name}\n${error.stack}`); }
}
const event = (id, action = 'explain', start = 10) => ({ id, action, urlKey: 'https://example.com/workbench',
  text: 'Source text', value: action === 'highlight' ? null : 'Original answer', createdAt: 1,
  anchor: { exact: 'Source text', start, end: start + 11 }, extra: { question: 'What?' } });
function app(items) {
  const a = new App(); a.items = items; a.online = true;
  a.panel = { render() {}, renderStatus() {}, syncMsg() {}, renderBrief(value) { a.brief = value; }, showUndo() {} };
  a.reanchor = () => {}; return a;
}

console.log('阅读工作台：分组、连续编辑、恢复与取消\n');
await test('同位置同引文分组，不把重复文字、重叠选区或失锚记录混在一起', () => {
  const items = [event('h','highlight'), event('e'), event('t','translate',50),
    { ...event('overlap'), anchor: { exact: 'Source', start: 10, end: 16 } }, event('orphan')];
  const groups = groupRecords(items, id => items.find(e => e.id === id).anchor.start, id => id === 'orphan');
  assert.deepEqual(groups.map(g => g.items.map(e => e.id)), [['h','e'],['overlap'],['orphan'],['t']]);
  assert.equal(matchesRecord({ ...event('search'), extra: { question: '独特问题' } }, 'explain', 'source 独特'), true);
  assert.equal(matchesRecord(event('search'), 'comments', 'source'), false);
});

await test('后台进度、筛选及切换标签保留输入 DOM、光标、展开状态和未提交补充', () => {
  const items = [event('typing'), { ...event('pending'), extra: { status: 'running' }, value: null }];
  let draft = '';
  const p = new Panel({ getItems: () => [], getLookups: kind => kind === 'explain' ? items : [],
    getStats: () => ({ position:0,quote:0,fuzzy:0,orphan:0 }), getNote: () => '', isOnline: () => true, outbox: () => 0,
    positionOf: () => 10, isOrphan: () => false, getLookupSupplement: () => draft,
    onLookupSupplementInput: (id,value) => { draft = value; }, api: {} });
  p.toggle(true, false);
  const editor = p.lookupComposers.get('typing'); const input = editor.list.querySelector('textarea');
  input.focus(); input.value = '未提交的补充'; input.dispatchEvent(new window.Event('input')); input.setSelectionRange(3,3);
  for (let i=0;i<8;i++) { items[1].extra.progress = `排队 ${i}`; p.render(); }
  assert.equal(p.lookupComposers.get('typing'), editor);
  assert.equal(editor.list.querySelector('textarea'), input);
  assert.equal(p.sh.activeElement, input); assert.equal(input.selectionStart, 3); assert.equal(input.value, '未提交的补充');
  p.records.select('comments'); p.records.select('all'); p.select('brief'); p.select('records');
  assert.equal(p.lookupComposers.get('typing'), editor);
  clearTimeout(editor.saveTimer);
});

await test('长回答默认收起、可展开、进度不重置；历史答案和操作位于回答前', () => {
  const item = { ...event('long'), value: '长答案。'.repeat(250), extra: { history: [{ value: '之前的答案', at:1 }] } };
  const p = new Panel({ getItems: () => [], getLookups: kind => kind === 'explain' ? [item] : [],
    getStats: () => ({position:0,quote:0,fuzzy:0,orphan:0}),getNote:()=>'',isOnline:()=>true,outbox:()=>0,
    positionOf:()=>10,isOrphan:()=>false,api:{} });
  p.toggle(true,false); const row = p.records.views.get('long').el;
  const details = row.querySelector('.answer-details'); assert.equal(details.open,false);
  assert.equal(row.querySelector('.answer-preview').hidden,false);
  details.open = true; p.render(); assert.equal(details.open,true);
  assert.equal(row.querySelector('.answer-history').hidden,false);
  assert.ok(row.querySelector('.record-actions').compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING);
});

await test('重新生成保留原答案和补充，成功后最多保留最近五个历史版本', () => {
  const initial = event('history'); initial.extra.supplement = '我的理解';
  const a = app([initial]);
  const { id } = a.beginLookup({text:initial.text, question:'What?', anchor:initial.anchor});
  assert.equal(id, initial.id); assert.equal(a.items[0].value,'Original answer');
  a.saveLookup('explain', {text:initial.text,value:'新答案',extra:{question:'What?'}});
  assert.equal(a.items[0].extra.supplement,'我的理解');
  assert.equal(a.items[0].extra.history[0].value,'Original answer');
  for(let i=0;i<8;i++) a.saveLookup('explain', {text:initial.text,value:`答案${i}`,extra:{question:'What?'}});
  assert.equal(a.items[0].extra.history.length,5);
});

await test('独立取消保留记录和旧答案，晚到结果不替换；刷新不会重试已取消请求', async () => {
  const item = event('cancel'); item.extra.status = 'running';
  const a = app([item]); let resolve;
  api.setTransport(async (path) => path === '/explain' ? new Promise(yes => { resolve = yes; }) : { status:200,body:{} });
  const run = a.pollExplain(item.id, {text:item.text,question:'What?',anchor:item.anchor});
  await a.cancelLookup(item.id);
  resolve({status:200,body:{answer:'不应覆盖'}}); await run;
  assert.equal(a.items[0].value,'Original answer'); assert.equal(a.items[0].extra.status,'canceled');
  let resumed = 0; a.followJob = () => resumed++; await a.resumePending(); assert.equal(resumed,0);
});

await test('离线删除撤销以同 ID 和更新 mutation 恢复批注草稿、图片引用和锚点', async () => {
  api.setTransport(async () => { throw new Error('offline-test'); });
  const h = event('undo-h','highlight');
  const c = {...event('undo-c','comment'),parentId:h.id,value:'旧批注'};
  const a = app([h,c]); await offline.saveOfflineEvents(a.items);
  const text = '刚输入的草稿\n![截图](contextflow-asset://image-test)'; a.commentDrafts.set(h.id,text);
  await a.deleteHighlight(h.id); assert.equal(a.items.length,0);
  const dead = (await offline.listOfflineEvents(a.key,{includeDeleted:true})).find(e=>e.id === h.id);
  assert.ok(dead.deletedAt);
  await a.undoDelete();
  assert.equal(a.items.find(e=>e.id===c.id).value,text);
  const restored = (await offline.listOfflineEvents(a.key)).find(e=>e.id===h.id);
  assert.equal(restored.deletedAt,null); assert.ok(restored.updatedAt>dead.updatedAt); assert.deepEqual(restored.anchor,h.anchor);
  await offline.applyRemoteEvents([dead]);
  assert.ok((await offline.listOfflineEvents(a.key)).some(e=>e.id===h.id), '旧 tombstone 不能再次删除撤销后的记录');
});

await test('取消作业传递 AbortSignal，底层退出前不抢占并发槽位', async () => {
  _reset(); let released, signal;
  const job = submit({kind:'test',label:'cancel',task: api => {signal=api.signal; return new Promise(yes=>{released=yes;});}});
  await new Promise(yes=>setTimeout(yes,0));
  assert.equal(cancel(job.id),true); assert.equal(signal.aborted,true); assert.equal(stats().running,1);
  assert.equal(cancel(job.id),false); released('late'); await new Promise(yes=>setTimeout(yes,0));
  assert.equal(get(job.id).status,'canceled'); assert.equal(get(job.id).result,null); assert.equal(stats().running,0);
});

await test('取消速览后立即重新生成，旧请求收尾不能清除新请求的忙碌状态', async () => {
  const a = app([]); a.index = {text:'原创测试正文。'.repeat(60)}; a.uploadArticle = async()=>{};
  const responses=[];
  api.setTransport(async path => path === '/summary' ? new Promise(yes=>responses.push(yes)) : {status:200,body:{}});
  const first = a.autoSummarize(true); await new Promise(yes=>setTimeout(yes,0));
  assert.equal(responses.length,1); a.cancelSummary();
  const second = a.autoSummarize(true); await new Promise(yes=>setTimeout(yes,0));
  assert.equal(responses.length,2);
  responses[0]({status:200,body:{summary:'旧的晚到答案'}}); await first;
  assert.equal(a.briefBusy,true); assert.equal(a.items.length,0);
  responses[1]({status:200,body:{summary:'本次新答案'}}); await second;
  assert.equal(a.items[0].value,'本次新答案'); assert.equal(a.briefBusy,false);
});

await test('删除后撤销翻译记录，旧翻译重试晚到也不能覆盖恢复的版本', async () => {
  const item=event('translate-late','translate'); const a=app([item]); let resolve;
  a.uploadArticle=async()=>{};
  api.setTransport(async path => path === '/translate' ? new Promise(yes=>{resolve=yes;}) : {status:200,body:{}});
  const running=a.retryLookup(item.id); await new Promise(yes=>setTimeout(yes,0));
  await a.deleteLookup(item.id); await a.undoDelete();
  resolve({status:200,body:{translation:'旧请求的晚到译文'}}); await running;
  assert.equal(a.items[0].value,'Original answer'); assert.equal(a.items[0].extra.status,'canceled');
});
console.log(`\n${passed} 项通过`);
