// 本地服务客户端。X-ContextFlow 头是安全模型的一半（强制预检），每个请求都必须带。
// 服务不可达时写入 localStorage outbox，恢复后自动补发 —— 服务没起也不丢标注。

const BASE = 'http://127.0.0.1:7317';
const OUTBOX = 'contextflow:outbox';

// 改名前的键是 ctxit:*。一次性搬过来，否则未推送的 outbox 和面板偏好会凭空消失。
(function migrateLegacyKeys() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('ctxit:')) continue;
      const nk = 'contextflow:' + k.slice('ctxit:'.length);
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch { /* 隐私模式下 localStorage 不可用，忽略 */ }
})();

// 构建时由 tools/build.mjs 从 ~/.contextflow/config.json 注入。
// allowAnyOrigin 打开后 X-ContextFlow 已拦不住任何 origin，token 是唯一防线。
// 注意：MAIN world 与页面共享 JS 堆，恶意页面理论上可在我方脚本前 hook fetch 窃取它 ——
// 这是userscript 载体的固有弱点，迁到扩展后 fetch 发生在 service worker，页面碰不到。
const TOKEN = typeof __CONTEXTFLOW_TOKEN__ === 'string' ? __CONTEXTFLOW_TOKEN__ : '';

const HEADERS = {
  'Content-Type': 'application/json',
  'X-ContextFlow': '1',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/**
 * 传输层。整个客户端的网络访问都收敛在这一个函数上，所以换载体只需换它。
 *
 * 默认实现直接 fetch —— userscript 用这条，token 编译进产物、和页面共享 JS 堆。
 * 扩展载体调 setTransport() 换成"转发给 service worker"：token 只存在于 SW 里，
 * 页面完全碰不到，于是服务端可以关掉 allowAnyOrigin、只白名单一个扩展 id。
 *
 * @returns {Promise<{status:number, body:object}>} 不抛网络错误，由 call() 统一判定
 */
let transport = async (path, init = {}) => {
  const res = await fetch(BASE + path, {
    ...init, headers: { ...HEADERS, ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

export function setTransport(fn) { transport = fn; }

const readOutbox = () => {
  try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; }
};
const writeOutbox = (list) => {
  try { localStorage.setItem(OUTBOX, JSON.stringify(list.slice(-500))); } catch { /* 配额满，丢弃最旧 */ }
};

async function call(path, init = {}) {
  const { status, body } = await transport(path, init);
  if (status < 200 || status >= 300) {
    throw Object.assign(new Error(body?.error || `HTTP ${status}`), { status, code: body?.code });
  }
  return body ?? {};
}

export async function health() { return call('/health'); }

export async function fetchEvents(urlKey) {
  const { events } = await call(`/events?urlKey=${encodeURIComponent(urlKey)}`);
  return events;
}

/** 推送事件；失败则入 outbox。返回是否直达服务。 */
export async function pushEvents(events) {
  if (!events.length) return true;
  try {
    await call('/events', { method: 'POST', body: JSON.stringify({ events }) });
    return true;
  } catch (e) {
    console.warn('[ContextFlow] 推送失败，已入 outbox：', e.message);
    writeOutbox([...readOutbox(), ...events]);
    return false;
  }
}

export async function deleteEvent(id) {
  try { await call(`/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); return true; }
  catch (e) { console.warn('[ContextFlow] 删除未同步：', e.message); return false; }
}

/** 补发积压。返回补发条数（0 表示无积压或仍失败）。 */
export async function flushOutbox() {
  const pending = readOutbox();
  if (!pending.length) return 0;
  try {
    await call('/events', { method: 'POST', body: JSON.stringify({ events: pending }) });
    writeOutbox([]);
    return pending.length;
  } catch { return 0; }
}

export function outboxSize() { return readOutbox().length; }

// ---- 配置界面 ----
export const getConfig = () => call('/config');
export const putConfig = (patch) => call('/config', { method: 'POST', body: JSON.stringify(patch) });
export const listModels = () => call('/llm/models');
export const listNotebooks = () => call('/siyuan/notebooks');
export const listVaults = () => call('/obsidian/vaults');
export const listFolders = (backend) => call(`/fs/folders?backend=${encodeURIComponent(backend)}`);
export const listPaths = (notebook) => call(`/siyuan/paths?notebook=${encodeURIComponent(notebook)}`);

/** 触发思源按天汇总同步。day 省略则为今天。 */
/**
 * 触发同步。不再有 day 参数 —— 同步单位是**文章**，一篇文章跨多少天读
 * 都汇到它自己那一个文档里。urlKey 可限定只同步当前这篇。
 */
export async function sync(urlKey) {
  return call('/sync', { method: 'POST', body: JSON.stringify(urlKey ? { urlKey } : {}) });
}

/** offset = 选区在归一化正文中的起始字符偏移，服务端据此决定要喂到第几段 */
export async function translate(text, target, urlKey, offset) {
  return call('/translate', { method: 'POST', body: JSON.stringify({ text, target, urlKey, offset }) });
}

/**
 * 上传正文，作为该文章连续对话的首条消息。
 * 浏览器手里本来就有正文，让服务端/agent 再抓一遍既慢又多一个失败点。
 * 服务端按内容哈希去重，重复上传是廉价的。
 */
export async function putArticle({ urlKey, title, url, text }) {
  return call('/article', { method: 'POST', body: JSON.stringify({ urlKey, title, url, text }) });
}

export async function getJob(id) {
  const { job } = await call(`/jobs/${encodeURIComponent(id)}`);
  return job;
}

export async function cancelJob(id) {
  try { return (await call(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })).canceled; }
  catch { return false; }
}

export async function detectAgents() { return call('/agents/detect'); }

/**
 * 解释。后端可能是 LLM（同步返回结果）或本地 agent（返回作业，需轮询）。
 * 用 onProgress 回调把排队/进度报给浮层 —— agent 实测要几十秒，
 * 没有反馈用户会以为卡死。
 */
export async function explain({ text, question, urlKey, offset, fresh, onProgress, signal }) {
  const first = await call('/explain', {
    method: 'POST', body: JSON.stringify({ text, question, urlKey, offset, fresh }),
  });
  if (first.mode !== 'job') return first;          // LLM 路径，直接就是答案

  let id = first.job.id;
  for (;;) {
    if (signal?.aborted) { cancelJob(id); throw Object.assign(new Error('已取消'), { code: 'ABORTED' }); }
    const job = await getJob(id);
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw Object.assign(new Error(job.error?.message || '作业失败'), { code: job.error?.code });
    if (job.status === 'canceled') throw Object.assign(new Error('作业已取消'), { code: 'ABORTED' });
    onProgress?.(job);
    await new Promise((r) => setTimeout(r, 1200));
  }
}
