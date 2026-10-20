import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { diagnosticReport } from '../src/core/diagnostics.js';
import { offlineStorageStats, saveOfflineEvents } from '../src/core/offline-store.js';
import { setupSupport } from '../src/ext/support.js';
const secret='PRIVATE_KEY_PATH_URL_NOTE';
const report=diagnosticReport({extensionVersion:'1.0.0',browserVersion:'123.0.6',
  connection:{state:'connected',token:secret,service:{serviceVersion:secret,apiKey:secret,modelDraftSupported:true,error:secret}},
  storage:{storedRows:3,pendingOperations:2,images:0,lastError:secret}});
assert.equal(JSON.stringify(report).includes(secret),false);
assert.equal(report.serviceVersion,'unknown');assert.equal(report.capabilities.modelDraft,true);
assert.equal(diagnosticReport({connection:{state:secret}}).connection,'error');
await saveOfflineEvents([{id:'report',urlKey:secret,action:'comment',text:secret,value:secret}]);
assert.deepEqual(await offlineStorageStats(),{storedRows:1,pendingOperations:1,images:0});
const dom=new JSDOM('<button id="support-check"></button><button id="support-copy"></button><p id="support-status"></p><pre id="support-report"></pre>');
setupSupport({root:dom.window.document,version:'1.0.0',request:async()=>{throw new Error(secret);},storageStats:async()=>{throw new Error(secret);}});
await dom.window.document.getElementById('support-check').onclick();
const text=dom.window.document.body.textContent;
assert.equal(text.includes(secret),false);assert.match(text,/私有存储检查失败/);
assert.equal(dom.window.document.getElementById('support-copy').disabled,false);
assert.equal(dom.window.document.getElementById('support-check').disabled,false);
console.log('脱敏报告：严格白名单、只读存储计数、失败可重试，不包含正文 / 密钥 / 原始错误');
