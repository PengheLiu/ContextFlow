// 扩展载体的 content script 入口。
//
// 跑在 **ISOLATED world**（MV3 默认）。这不是将就 —— 已实测那里注册的
// CSS.highlights 会在页面上正常绘制（探针：ISOLATED 注册的 ::highlight() 与普通
// <mark> 视觉一致）。所以 UI、锚定、高亮全部留在这里，页面 JS 碰不到我们的任何东西。
//
// 与 userscript 入口（src/skill/main.js）的唯一差别就是**传输层**：
// 那边直接 fetch 并把 token 编译进产物；这边转发给 service worker，token 只在 SW 里。
import { initializePrivateStorage } from './storage.js';
import { request } from './rpc.js';
import { setTransport, setStreamTransport } from '../core/api.js';
import { boot } from '../skill/main.js';
import { blockedScope, showUnblockChip } from '../skill/blocklist.js';
import { createContentStartup, startupFailureNotice } from './startup.js';

/**
 * 把请求转给 service worker。
 *
 * 刻意不抛异常，把"服务不可达"表示成 status 0 —— api.js 的 call() 据此判定失败，
 * 上层的 outbox 逻辑就与 userscript 路径完全一致，不必为扩展另写一套。
 */
setTransport((path, init = {}) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };

  // service worker 可能正在冷启动；给一个上限，别让界面无限等
  const timer = setTimeout(() => finish({
    status: 0, body: { error: 'service worker 无响应' },
  }), 30000);

  try {
    chrome.runtime.sendMessage(
      { type: 'cf-fetch', path, init: { method: init.method, body: init.body, headers: init.headers } },
      (res) => {
        clearTimeout(timer);
        // 扩展被重载/更新后旧的 content script 会失去通道，这里必须接住，
        // 否则表现为静默失败（chrome.runtime.lastError 不读就会变成未捕获警告）
        const err = chrome.runtime.lastError;
        if (err) return finish({ status: 0, body: { error: `扩展通道断开：${err.message}` } });
        finish(res || { status: 0, body: { error: 'service worker 未返回' } });
      },
    );
  } catch (e) {
    clearTimeout(timer);
    finish({ status: 0, body: { error: `无法联系 service worker：${e.message}` } });
  }
}));

setStreamTransport((id, onJob, signal) => new Promise((resolve, reject) => {
  let port, done = false, timer;
  const finish = (error) => {
    if (done) return;
    done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    try { port?.disconnect(); } catch { /* Extension may have been reloaded. */ }
    if (error) reject(error); else resolve();
  };
  const abort = () => finish(Object.assign(new Error('已取消'), { code: 'ABORTED' }));
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('扩展事件通道超时')), 45000); };
  if (signal?.aborted) { abort(); return; }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    port = chrome.runtime.connect({ name: 'cf-job-stream' });
    port.onMessage.addListener((message) => {
      if (done) return;
      arm();
      if (message.type === 'job') onJob(message.job);
      else if (message.type === 'end') finish();
      else if (message.type === 'error') finish(new Error(message.error));
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      finish(new Error(error?.message || '扩展事件通道断开'));
    });
    arm(); port.postMessage({ id });
  } catch (error) { finish(error); }
}));

let app;
const notice=startupFailureNotice({retry:()=>startup.retry(),help:()=>request({type:'cf-open-settings',view:'support'})});
const startup=createContentStartup({
  initialize:initializePrivateStorage,
  supported:()=>/^https?:$/.test(location.protocol) && window===window.top,
  blocked:blockedScope,showBlocked:showUnblockChip,showError:notice.show,clearError:notice.clear,
  start:()=>{
  app = boot();
  if (app) {
    app.openConnectionSettings = () => request({ type: 'cf-open-settings' });
    app.openReadingLibrary = () => request({type:'cf-open-library'});
    app.panel?.renderStatus();
  }
  return app;
  },
});
void startup.start();

// 点扩展图标切换面板。userscript 路径没有这个入口（只能点右缘把手），
// 扩展有图标就顺手接上。
// 实例不存在且页面在停用名单里时，图标点击就是恢复入口 —— 扩展载体没有
// userscript那种"重复执行"的手势，用户主动点图标是唯一明确的敲门信号。
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if(msg?.type==='cf-flush-edits') {
    if(!app){reply({contextflow:true,ok:startup.ready});return;}
    Promise.resolve(app.ready).then(ready=>{
      if(ready===false)throw new Error('本地阅读记录尚未准备好');
      return app.flushForNavigation();
    }).then(()=>reply({contextflow:true,ok:true}),()=>reply({contextflow:true,ok:false}));
    return true;
  }
  if (msg?.type === 'cf-connection-changed') {
    app?.refreshConnection?.();
    return;
  }
  if (msg?.type !== 'cf-toggle') return;
  if (app) app.togglePanel();
  else {
    const scope = blockedScope();
    if (scope) showUnblockChip(scope);
    else startup.show();
  }
});
