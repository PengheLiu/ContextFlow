import * as offline from '../src/core/offline-store.js';
import { encodeMessage, decodeMessage } from '../src/ext/rpc.js';
import { companionInfo } from '../src/core/companion-info.js';
import { readJobStream } from '../src/core/job-stream.js';
import { randomUUID } from '../src/core/uuid.js';

const BASE = 'http://127.0.0.1:7317';
const TOKEN = typeof __CONTEXTFLOW_TOKEN__ === 'string' ? __CONTEXTFLOW_TOKEN__ : '';
const OK_PATH = /^\/(health|events|assets|article|translate|explain|summary|jobs|config|llm|agents|obsidian|fs|siyuan|sync)(\/|\?|$)/;
const preferenceKeys = ['contextflow:ui', 'contextflow:pop', 'contextflow:blocklist'];
const offlineMethods = new Set([
  'saveOfflineEvents', 'tombstoneOfflineEvents', 'listOfflineEvents',
  'saveOfflineAsset', 'getOfflineAsset', 'listPendingAssets', 'markOfflineAssetUploaded',
  'claimOperations', 'acknowledgeOperations', 'releaseOperations', 'operationCount',
  'applyRemoteEvents', 'putOfflineArticle', 'getOfflineArticle',
  'migrateLegacyOutbox', 'migrateArticleMirror',
  'migrateArticleIdentity',
]);
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function connectionToken() {
  await storageReady;
  const { connection } = await chrome.storage.local.get('connection');
  return connection ? connection.token || '' : TOKEN;
}

async function instanceHeaders(token, instanceId) {
  if (instanceId === undefined) {
    const { connection } = await chrome.storage.local.get('connection');
    instanceId = connection?.token === token ? connection.instanceId : '';
  }
  return instanceId ? { 'X-ContextFlow-Instance': instanceId } : {};
}

async function fetchService(path, init = {}, token, instanceId) {
  if (typeof path !== 'string' || !OK_PATH.test(path) || path.includes('\\') || path.includes('..')) {
    return { status: 400, body: { error: `路径不被放行：${path}` } };
  }
  if (!token) return { status: 428, body: { error: 'AI 和笔记同步尚未开启，请在侧栏点击「开启 AI / 同步」；批注和导出可直接使用', code: 'PAIRING_REQUIRED' } };
  if (!['GET', 'POST', 'DELETE'].includes(init.method || 'GET')) {
    return { status: 400, body: { error: '不支持的请求方法' } };
  }
  try {
    const response = await fetch(BASE + path, {
      method: init.method || 'GET', body: init.body,
      headers: { 'Content-Type': 'application/json', 'X-ContextFlow': '1', Authorization: `Bearer ${token}`,
        ...(token !== TOKEN ? { 'X-ContextFlow-Extension': chrome.runtime.id } : {}), ...await instanceHeaders(token, instanceId) },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } catch (error) {
    return { status: 0, body: { error: `本地服务不可达：${error.message}` } };
  }
}

function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  if (sender.url?.split('#')[0] === chrome.runtime.getURL('options.html')) return 'settings';
  if (/^https?:\/\//.test(sender.url || '') && sender.tab && sender.frameId === 0) return 'page';
  return null;
}

// The content script can subscribe to a job, but never sees the pairing token.
chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'cf-job-stream') return;
  if (!senderKind(port.sender || {})) { port.disconnect(); return; }
  const controller = new AbortController();
  let started = false, closed = false, headerTimer, heartbeat;
  const send = (message) => { if (!closed) { try { port.postMessage(message); } catch { controller.abort(); } } };
  port.onDisconnect.addListener(() => { closed = true; controller.abort(); clearTimeout(headerTimer); clearInterval(heartbeat); });
  port.onMessage.addListener(async (message) => {
    if (started) return;
    started = true;
    try {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(message?.id || '')) throw new Error('无效的作业编号');
      const token = await connectionToken();
      if (!token) throw new Error('本地服务尚未配对');
      if (closed) return;
      headerTimer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${BASE}/jobs/${encodeURIComponent(message.id)}/stream`, {
        headers: { 'X-ContextFlow': '1', Authorization: `Bearer ${token}`,
          ...(token !== TOKEN ? { 'X-ContextFlow-Extension': chrome.runtime.id } : {}), ...await instanceHeaders(token) },
        signal: controller.signal, redirect: 'error',
      });
      clearTimeout(headerTimer); send({ type: 'ready' });
      heartbeat = setInterval(() => send({ type: 'ping' }), 15000);
      await readJobStream(response, (job) => send({ type: 'job', job }), { signal: controller.signal });
      send({ type: 'end' });
    } catch { send({ type: 'error', error: '任务事件流不可用，正在重新读取进度' }); }
    finally {
      clearTimeout(headerTimer); clearInterval(heartbeat); controller.abort();
      if (!closed) { closed = true; port.disconnect(); }
    }
  });
});

async function notifyConnectionChanged() {
  try {
    const tabs = await chrome.tabs.query?.({}) || [];
    await Promise.allSettled(tabs.filter((tab) => tab.id != null).map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: 'cf-connection-changed' })));
  } catch { /* Tab refresh is best-effort; successful pairing must still succeed. */ }
}

async function handleMessage(message, sender, kind) {
  await storageReady;
  if (message.type === 'cf-offline') {
    if (kind !== 'page' || !offlineMethods.has(message.method) || !Array.isArray(message.args)) {
      throw new Error('不允许的存储操作');
    }
    return offline[message.method](...decodeMessage(message.args));
  }
  if (message.type === 'cf-ui-snapshot' || message.type === 'cf-ui-write') {
    if (kind !== 'page') throw new Error('仅网页扩展界面可访问站点偏好');
    const origin = new URL(sender.url).origin;
    const storageKey = (key) => `preferences:${origin}:${key}`;
    if (message.type === 'cf-ui-snapshot') {
      const stored = await chrome.storage.local.get(preferenceKeys.map(storageKey));
      return Object.fromEntries(preferenceKeys.map((key) => [key, stored[storageKey(key)] ?? null]));
    }
    if (!preferenceKeys.includes(message.key) || (message.value !== null &&
      (typeof message.value !== 'string' || message.value.length > 65536))) throw new Error('无效的偏好设置');
    if (message.value === null) await chrome.storage.local.remove(storageKey(message.key));
    else await chrome.storage.local.set({ [storageKey(message.key)]: message.value });
    return true;
  }
  if (message.type === 'cf-open-settings') {
    if (kind !== 'page') throw new Error('仅网页扩展界面可打开连接设置');
    const view=message.view==='support' ? 'support' : 'connect';
    await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${view}`) });
    return true;
  }
  if (message.type === 'cf-open-library') {
    if(kind!=='page')throw new Error('仅阅读界面可打开阅读库');
    await chrome.tabs.create({url:chrome.runtime.getURL('options.html#library')});return true;
  }
  if (kind !== 'settings') throw new Error('只能在扩展自己的设置页进行配对');
  if(message.type==='cf-flush-reading') {
    const tabs=await chrome.tabs.query?.({}) || [];
    const results=await Promise.allSettled(tabs.filter(tab=>tab.id!=null).map(async tab=>{
      let timer;
      try{return await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'cf-flush-edits'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('保存确认超时')),15000);})]);}
      finally{clearTimeout(timer);}
    }));
    if(results.some(row=>row.status==='fulfilled' ? row.value?.contextflow===true && row.value.ok===false
      : !/Receiving end does not exist|Could not establish connection|No tab with id|The tab was closed/.test(row.reason?.message || '')))throw new Error('有文章的编辑尚未确认保存，请回到原页面处理后重试；未生成不完整备份或恢复记录。');
    return true;
  }
  if (message.type === 'cf-configuration-changed') { await notifyConnectionChanged(); return true; }
  if (message.type === 'cf-status') {
    const { connection } = await chrome.storage.local.get('connection');
    return { paired: !!(await connectionToken()), extensionId: chrome.runtime.id,
      source: connection?.source === 'desktop' ? 'desktop' : 'companion' };
  }
  if (message.type === 'cf-check') {
    const token = await connectionToken();
    if (!token) return { state: 'unpaired' };
    const result = await fetchService('/health', {}, token);
    if (result.status === 0) return { state: 'unavailable' };
    if (result.status === 401 || result.status === 403) return { state: 'unauthorized' };
    if (result.status === 200 && result.body.ok && (token === TOKEN || result.body.extensionPaired === true)) {
      const service = companionInfo(result.body);
      return { state: service.modelDraftSupported ? 'connected' : 'update-required', service };
    }
    return { state: result.status === 200 || result.status === 404 ? 'incompatible' : 'error' };
  }
  if (message.type === 'cf-disconnect') {
    await chrome.storage.local.set({ connection: { disconnected: true } });
    await notifyConnectionChanged();
    return true;
  }
  if (message.type === 'cf-connect-native') {
    if (message.consent !== true) throw new Error('请先确认本地连接的数据使用说明');
    if (typeof chrome.runtime.connectNative !== 'function') throw new Error('当前扩展尚不支持桌面连接，请更新扩展。');
    const stored = await chrome.storage.local.get('desktopInstanceId');
    const instanceId = stored.desktopInstanceId || randomUUID();
    await chrome.storage.local.set({ desktopInstanceId: instanceId });
    const result = await new Promise((resolve, reject) => {
      // An explicit native port keeps the MV3 worker alive while the user is
      // reading the desktop approval dialog. Always close it after one reply.
      const port = chrome.runtime.connectNative('io.github.pengheliu.contextflow');
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return; settled = true; port.disconnect(); reject(new Error('桌面端授权超时，请返回桌面端处理后重试。'));
      }, 90000);
      port.onMessage.addListener(response => {
        if (settled) return; settled = true; clearTimeout(timer); resolve(response); port.disconnect();
      });
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError; // consume even after a handled response
        if (settled) return; settled = true; clearTimeout(timer);
        reject(new Error('桌面端未连接。请先安装并打开 ContextFlow 桌面端，再重试；如使用组织管理的 Chrome，请确认原生消息未被策略禁用。'));
      });
      port.postMessage({ type: 'pair', protocolVersion: 1, consent: true, instanceId, label: `Chrome · ${instanceId.slice(0, 8)}` });
    });
    if (!result?.ok) throw new Error(result?.error || '桌面端未完成连接授权');
    if (result.protocolVersion !== 1 || result.baseUrl !== BASE || !/^[A-Za-z0-9_-]{43}$/.test(result.token || '')) {
      throw new Error('桌面端连接协议或端口不兼容，请更新配套桌面端。');
    }
    const health = await fetchService('/health', {}, result.token, instanceId);
    if (health.status !== 200 || health.body.extensionPaired !== true) throw new Error('桌面端已授权，但服务连接未验证成功；请检查本地服务后重试。');
    await chrome.storage.local.set({ connection: { token: result.token, instanceId, consentVersion: 1, pairedAt: Date.now(), source: 'desktop' } });
    await notifyConnectionChanged();
    return { paired: true };
  }
  if (message.type === 'cf-connect') {
    const token = typeof message.token === 'string' ? message.token.trim() : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('配对码格式不正确，请重新从本地命令复制');
    if (message.consent !== true) throw new Error('请先阅读并确认数据使用说明');
    const result = await fetchService('/health', {}, token);
    if (result.status !== 200 || !result.body.ok || result.body.extensionPaired !== true) {
      if (result.status === 0) throw new Error('本地服务没有响应。保持运行服务的终端打开，看到 127.0.0.1:7317 后再点「验证并连接」；已填写的配对码可以重试。');
      if (result.status === 401 || result.status === 403) throw new Error('配对码不属于当前扩展、已失效或被撤销。请用本页命令重新生成，只复制 43 位配对码。');
      throw new Error('本地服务响应不兼容。请下载本页提供的配套服务包，启动后重新验证；不要把模型 API key 当作配对码。');
    }
    await chrome.storage.local.set({ connection: { token, consentVersion: 1, pairedAt: Date.now() } });
    await notifyConnectionChanged();
    return { paired: true };
  }
  throw new Error('未知扩展消息');
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('cf-')) return false;
  const kind = senderKind(sender);
  if (!kind) { reply({ ok: false, error: '不可信的消息来源' }); return false; }
  if (message.type === 'cf-fetch') {
    connectionToken().then((token) => fetchService(message.path, message.init, token))
      .then(reply).catch(() => reply({ status: 0, body: { error: '扩展安全存储不可用' } }));
  } else {
    handleMessage(message, sender, kind).then(encodeMessage)
      .then((value) => reply({ ok: true, value }))
      .catch((error) => reply({ ok: false, error: error.message }));
  }
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(async (tab) => {
  // 离线批注是完整可用的起点，未配对也应先打开文章侧栏。
  if (tab?.id != null) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'cf-toggle' }); }
    catch {
      // No new permissions and no page URL is collected. Explain the missing
      // reading surface instead of implying a failed click requires AI pairing.
      await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#reading-help') });
    }
  }
});
