// 本地服务：只 bind 127.0.0.1，零外部依赖（除翻译用的官方 Anthropic SDK）。
//
// 安全模型（DESIGN.md §0）：脚本跑在页面 MAIN world，服务端无法区分我方脚本
// 与恶意页面的请求，因此防线是两条，而不是 token：
//   1. CORS 只放行白名单 origin  → 非白名单站点读不到响应
//   2. 强制要求自定义头 X-ContextFlow   → 任何跨源请求都必须预检，预检失败则请求根本不发出。
//      少了这条，Content-Type: text/plain 的「简单请求」POST 能绕过 CORS 往库里写垃圾。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig, saveConfig, publicView, setupStatus, CONFIG_PATH, DIR } from './config.mjs';
import * as db from './db.mjs';
import * as lookup from './lookup.mjs';
import { listModels, testConnection, modelDraft } from './llm.mjs';
import { listNotebooks, listPaths } from './siyuan.mjs';
import { syncAll, describe, BACKENDS } from './sync.mjs';
import { SyncStatus } from './sync-status.mjs';
import { ReadingStatus } from './reading-status.mjs';
import * as jobs from './jobs.mjs';
import { originAllowed, EXT_ORIGIN_RE } from './origin.mjs';
import { detect as detectAgents, AGENTS, close as closeAgents } from './agent.mjs';
import { agentTestConfig, prepareAgentTest, testAgentConnection } from './agent-test.mjs';
import { ConnectionChecks } from './connection-checks.mjs';
import { detectVaults, listFolders } from './obsidian.mjs';
import { getAsset, saveAsset } from './assets.mjs';
import { pairedOrigin, extensionAuthorized } from './extension-pairing.mjs';

let cfg = loadConfig();   // POST /config 会热替换
const connectionChecks = new ConnectionChecks(DIR, cfg.token);
const syncStatus = new SyncStatus(DIR);
const readingStatus = new ReadingStatus(DIR, cfg.token);
const settingsView = async (current = cfg) => {
  const installed = current.agent?.id ? await detectAgents(false, current.agent) : [];
  return { ...publicView(current), connectionChecks: connectionChecks.view(current, installed) };
};
// 在进程启动时捕获，不能因为磁盘源码已更新就把旧进程误报成新版。
const serviceVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const startedAt = new Date().toISOString();
const desktopToken = process.env.CONTEXTFLOW_DESKTOP_TOKEN || '';
let stateRevision = 0;
function stateChanged() {
  stateRevision++;
  if (desktopToken && process.connected && typeof process.send === 'function') {
    process.send({ type: 'contextflow-state-changed', revision: stateRevision }, () => {});
  }
}
function answered(configuration, result, options) {
  if (options?.signal?.aborted) return result;
  readingStatus.answer(configuration, result, options); stateChanged(); return result;
}
function healthView(current, extensionPaired = false) {
  return { ok: true, stats: db.stats(current.sync.backend),
    serviceVersion, startedAt, stateRevision,
    capabilities: ['llm.models', 'llm.test', 'llm.draft', 'jobs.abort', 'jobs.stream', 'agent.test', 'agent.test.draft', 'connection.checks', 'reading.status'], jobs: jobs.stats(),
    extensionPaired,
    ...(desktopToken ? { desktopManaged: true, protocolVersion: 1 } : {}),
    syncStatus: syncStatus.view(current), readingStatus: readingStatus.view(current),
    hasApiKey: !!current.translate.apiKey, backend: current.sync.backend, backends: BACKENDS, ...setupStatus(current) };
}
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ASSET_BODY = 12 * 1024 * 1024; // 8 MB 图片经 Base64/JSON 传输后的上限

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
};

const rejected = new Set();   // 同一 origin 只提示一次，避免刷屏

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // 无 Origin：curl / 同源，放行
  if (!originAllowed(cfg, origin) && !pairedOrigin(origin)) {
    if (!rejected.has(origin)) {
      rejected.add(origin);
      console.warn(`[cors] 拒绝 ${origin}\n`
        + `       要允许它：把 "${origin}" 加入 ${CONFIG_PATH} 的 allowedOrigins（支持 * 通配符），然后重启服务`);
    }
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ContextFlow, X-Ctxit, X-ContextFlow-Extension, X-ContextFlow-Instance, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('JSON 解析失败'), { code: 'BAD_JSON' })); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    const extensionId = req.headers['x-contextflow-extension'];
    const claimedOrigin = extensionId ? `chrome-extension://${extensionId}` : req.headers.origin;
    if (extensionId && (!/^[a-p]{32}$/.test(extensionId) ||
      (req.headers.origin && req.headers.origin !== claimedOrigin))) {
      return json(res, 403, { error: '扩展身份与请求来源不一致' });
    }
    if (!applyCors(req, res)) {
      return json(res, 403, { error: `origin 不在白名单：${req.headers.origin}`, hint: `编辑 ${CONFIG_PATH} 的 allowedOrigins` });
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 强制预检的关键：缺这个头直接拒。
  // 同时接受改名前的 X-Ctxit —— 否则宿主里还粘着旧版 dist/skill.js 时，
  // 一升级服务端就全线 403，且错误信息在 CORS 下读不到，极难自查。
    if (req.headers['x-contextflow'] !== '1' && req.headers['x-ctxit'] !== '1') {
      return json(res, 403, { error: '缺少 X-ContextFlow: 1 请求头' });
    }
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const extensionAuth = extensionAuthorized(claimedOrigin, tok, req.headers['x-contextflow-instance'] || '');
    if (extensionAuth === false || (extensionId && extensionAuth !== true)) {
      return json(res, 401, { error: '扩展尚未配对、配对已撤销或配对码无效' });
    }
    if (extensionAuth === null && (cfg.requireToken || desktopToken)) {
      const desktopAuthorized = desktopToken && tok === desktopToken && !req.headers.origin && !extensionId;
      if (tok !== cfg.token && !desktopAuthorized) return json(res, 401, { error: 'token 无效' });
    }

    if (path === '/health') {
      return json(res, 200, healthView(cfg, extensionAuth === true));
    }
    if (path === '/desktop/state' && req.method === 'GET') {
      if (!desktopToken || tok !== desktopToken || req.headers.origin || extensionId) return json(res, 403, { error: '此状态接口仅供桌面端使用' });
      const current = cfg;
      const configuration = await settingsView(current);
      // The immutable config reference binds every receipt in this response,
      // even when a browser saves another config while detection is awaiting.
      return json(res, 200, { configuration, health: healthView(current, extensionAuth === true) });
    }

    if (path === '/events' && req.method === 'GET') {
      const key = url.searchParams.get('urlKey');
      if (!key) return json(res, 400, { error: '缺少 urlKey' });
      return json(res, 200, { events: db.listByUrlKey(key) });
    }

    if (path === '/events' && req.method === 'POST') {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : (body.events || []);
      const ids = db.upsertEvents(list);
      return json(res, 200, { ok: true, saved: ids.length, ids });
    }

    if (path === '/assets' && req.method === 'POST') {
      const body = await readBody(req, MAX_ASSET_BODY);
      return json(res, 200, { asset: saveAsset(body) });
    }

    if (path.startsWith('/assets/') && req.method === 'GET') {
      const id = decodeURIComponent(path.slice('/assets/'.length));
      const asset = getAsset(id, { includeData: true });
      return asset ? json(res, 200, { asset }) : json(res, 404, { error: '附件不存在' });
    }

    if (path.startsWith('/events/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/events/'.length));
      return json(res, 200, { ok: db.softDelete(id) });
    }

    if (path === '/translate' && req.method === 'POST') {
      const requestConfig = cfg;
      const { text, target, urlKey, offset, fresh } = await readBody(req);
      // 翻译始终走 LLM，但它要知道总结/解释是否走 agent，才能决定历史是
      // "只有翻译"还是"总结+解释+翻译共享"。上一版没传，默认 false，
      // 导致 agent 明明在用，LLM 翻译对话里仍混进了 agent 的总结/解释。
      const { viaAgent } = await lookup.plan(requestConfig);
      return json(res, 200,
        answered(requestConfig, await lookup.translate({ text, target, urlKey, offset, fresh, cfg: requestConfig, viaAgent }), { translation: true }));
    }

    // 前端上传正文，供连续对话作首条消息。浏览器手里本来就有正文，
    // 让 agent 再抓一遍既慢又多一个失败点。
    if (path === '/article' && req.method === 'POST') {
      const { urlKey, title, url: src, text } = await readBody(req);
      return json(res, 200, lookup.putArticle({ urlKey, title, url: src, text }));
    }

    if (path === '/explain' && req.method === 'POST') {
      // Settings may be saved from another tab while this task is queued.
      // Keep the endpoint, credentials, Agent and permissions chosen at submit.
      const requestConfig = cfg;
      const { text, question, urlKey, offset, fresh, async: asynchronous } = await readBody(req);
      // plan() 含降级：配了 agent 但本机找不到时退回 LLM，并把原因带回去
      const { mode, degraded } = await lookup.plan(requestConfig);
      if (mode === 'sync' && !asynchronous) {
        const r = await lookup.explainViaLLM({ text, question, urlKey, offset, fresh, cfg: requestConfig });
        return json(res, 200, answered(requestConfig, { ...r, ...(degraded ? { degraded } : {}) }));
      }
      // agent 路径实测 10 轮 / 32 秒，不能同步等在 HTTP 上：立刻回 jobId，前端轮询
      const job = jobs.submit({
        kind: 'explain',
        label: String(text ?? '').slice(0, 40),
        task: async (api) => answered(requestConfig, { ...await (mode === 'sync' ? lookup.explainViaLLM : lookup.explainViaAgent)({
          text, question, urlKey, offset, fresh, cfg: requestConfig, onProgress: api.progress, onEvent: api.event, signal: api.signal,
        }), ...(degraded ? { degraded } : {})
        }, { signal: api.signal }),
      });
      return json(res, 202, { job, mode: 'job' });
    }

    // 速览：打开面板时给一段全文概述。与解释同一条对话，所以后面提问能接上。
    if (path === '/summary' && req.method === 'POST') {
      const requestConfig = cfg;
      const { urlKey, fresh, async: asynchronous } = await readBody(req);
      const { mode, degraded } = await lookup.plan(requestConfig);
      if (mode === 'sync' && !asynchronous) {
        const r = await lookup.summarize({ urlKey, fresh, cfg: requestConfig });
        return json(res, 200, answered(requestConfig, { ...r, ...(degraded ? { degraded } : {}) }));
      }
      const job = jobs.submit({
        kind: 'summary',
        label: '速览',
        task: async (api) => answered(requestConfig, await lookup.summarize({ urlKey, fresh, cfg: requestConfig, onProgress: api.progress, onEvent: api.event, signal: api.signal }), { signal: api.signal }),
      });
      return json(res, 202, { job, mode: 'job' });
    }

    const streamMatch = /^\/jobs\/([^/]+)\/stream$/.exec(path);
    if (streamMatch && req.method === 'GET') {
      const id = decodeURIComponent(streamMatch[1]);
      if (!jobs.get(id)) return json(res, 404, { error: '作业不存在或已过期' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.flushHeaders();
      let timer, pending, closed = false, unsubscribe = () => {};
      const cleanup = () => {
        if (closed) return;
        closed = true; clearTimeout(timer); clearInterval(heartbeat); unsubscribe();
      };
      const publish = (job) => {
        if (closed || res.destroyed) return;
        // Snapshots let clients recover without replaying a partially completed action.
        if (res.writableLength > 2 * 1024 * 1024) { cleanup(); res.end(); return; }
        res.write(`id: ${job.revision}\ndata: ${JSON.stringify({ job })}\n\n`);
        if (['done', 'error', 'canceled'].includes(job.status)) { cleanup(); res.end(); }
      };
      const heartbeat = setInterval(() => {
        if (!closed && !res.destroyed) res.write(': heartbeat\n\n');
      }, 15000);
      heartbeat.unref();
      unsubscribe = jobs.subscribe(id, (job) => {
        pending = job;
        if (['done', 'error', 'canceled'].includes(job.status)) { clearTimeout(timer); publish(job); }
        else if (!timer) timer = setTimeout(() => { timer = null; publish(pending); }, 50);
      });
      res.once('close', cleanup);
      publish(jobs.get(id));
      return;
    }

    if (path.startsWith('/jobs/') && req.method === 'GET') {
      const job = jobs.get(path.slice('/jobs/'.length));
      if (!job) return json(res, 404, { error: '作业不存在或已过期' });
      return json(res, 200, { job });
    }
    if (path.startsWith('/jobs/') && req.method === 'DELETE') {
      return json(res, 200, { canceled: jobs.cancel(path.slice('/jobs/'.length)) });
    }

    if (path === '/agents/detect' && req.method === 'GET') {
      // fresh=1：手动点「检测」时绕过缓存
      const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1';
      const agents = await detectAgents(fresh, cfg.agent);
      return json(res, 200, { agents, jobs: jobs.stats(), connectionChecks: connectionChecks.view(cfg, agents) });
    }
    if (path === '/agents/test' && req.method === 'POST') {
      const body = await readBody(req);
      const testConfig = agentTestConfig(body, cfg);
      if(body.id!=='dsh' && AGENTS[body.id].safeSupport==='unsupported') throw Object.assign(new Error('此 Agent 暂不支持受限连接测试，请改选支持受限测试的 Agent。'),{code:'AGENT_SAFE_UNSUPPORTED'});
      const job = jobs.submit({ kind:'agent-test', label:`测试 ${AGENTS[body.id].label}`,
        task: async api => {
          api.progress('正在确认 Agent 安装…');
          const prepared=await prepareAgentTest(body.id,testConfig);
          api.signal.throwIfAborted();api.progress('正在验证 Agent 实际回答…');
          const ticket=connectionChecks.begin(connectionChecks.agentKey(prepared));
          try {
            const result=await testAgentConnection(prepared,{signal:api.signal});
            api.signal.throwIfAborted();
            connectionChecks.finish(ticket,true,result.checkedAt);
            stateChanged();
            return result;
          } catch(error) {
            if(!api.signal.aborted) { connectionChecks.finish(ticket,false); stateChanged(); }
            else connectionChecks.discard(ticket);
            throw error;
          }
        } });
      return json(res, 202, { mode:'job', job });
    }

    // ---- 配置界面 ----
    if (path === '/config' && req.method === 'GET') {
      return json(res, 200, await settingsView());
    }
    if (path === '/config' && req.method === 'POST') {
      const patch = await readBody(req);
      cfg = saveConfig(patch);            // 落盘并热替换内存态
      stateChanged();
      console.log('[config] 已更新：' + Object.keys(patch).join(', '));
      return json(res, 200, await settingsView());
    }
    if (path === '/llm/models' && req.method === 'GET') {
      return json(res, 200, { models: await listModels(cfg) });
    }
    if (path === '/llm/models' && req.method === 'POST') {
      return json(res, 200, { models: await listModels(modelDraft(cfg, await readBody(req))) });
    }
    if (path === '/llm/test' && req.method === 'POST') {
      const draft=modelDraft(cfg, await readBody(req));
      const ticket=connectionChecks.begin(connectionChecks.modelKey(draft));
      try {
        const result=await testConnection(draft), checkedAt=Date.now();
        connectionChecks.finish(ticket,true,checkedAt);
        stateChanged();
        return json(res, 200, { ...result, checkedAt });
      } catch(error) { connectionChecks.finish(ticket,false); stateChanged(); throw error; }
    }
    if (path === '/obsidian/vaults' && req.method === 'GET') {
      return json(res, 200, { vaults: detectVaults() });
    }
    // 只接受后端名，根目录由服务端解析 —— 不做成任意路径的目录浏览器
    if (path === '/fs/folders' && req.method === 'GET') {
      const be = url.searchParams.get('backend');
      const root = be === 'obsidian' ? cfg.obsidian.vaultPath
        : be === 'markdown' ? cfg.markdown.dir : null;
      if (!root) return json(res, 400, { error: `后端 ${be} 未配置根目录` });
      return json(res, 200, { root, folders: listFolders(root) });
    }
    if (path === '/siyuan/notebooks' && req.method === 'GET') {
      return json(res, 200, { notebooks: await listNotebooks(cfg) });
    }
    if (path === '/siyuan/paths' && req.method === 'GET') {
      const nb = url.searchParams.get('notebook') || cfg.siyuan.notebookId;
      return json(res, 200, { paths: await listPaths(cfg, nb) });
    }

    // /sync/siyuan 是改名前的路径，宿主里可能还是旧构建，留作别名
    if ((path === '/sync' || path === '/sync/siyuan') && req.method === 'POST') {
      const { urlKey } = await readBody(req);
      const requestConfig = cfg;
      const out = await syncAll(requestConfig, urlKey ? { urlKey } : {});
      syncStatus.record(requestConfig, out);
      readingStatus.sync(requestConfig, out); stateChanged();
      const where = (out.files || out.docs || []).join(', ') || '(无变化)';
      console.log(`[sync] ${out.backend} · ${out.articles} 篇 · 新增 ${out.inserted}`
        + ` / 改写 ${out.updated} → ${where}`);
      return json(res, 200, out);
    }

    return json(res, 404, { error: `无此路由 ${req.method} ${path}`, code: 'ROUTE_NOT_FOUND' });
  } catch (e) {
    const map = { NEED_TEXT: 409, NO_AGENT: 503, AGENT_SPAWN: 503, AGENT_TIMEOUT: 504,
                  AGENT_EMPTY: 502, AGENT_ERROR: 502, AGENT_PARSE: 502, AGENT_AUTH: 502, AGENT_TEST_RESPONSE: 502, BAD_AGENT: 400,
                  NO_API_KEY: 503, TOO_LONG: 413, BAD_INPUT: 400, BAD_CONFIG: 400, BAD_JSON: 400,
                  TOO_LARGE: 413, SIYUAN_DOWN: 503, SIYUAN_AUTH: 503, SIYUAN: 502,
                  NO_MODEL: 503, NO_BASEURL: 503, UPSTREAM: 502,
                  NO_TARGET: 503, BAD_TARGET: 400, BAD_BACKEND: 400,
                  AGENT_FULL_ACK: 400, AGENT_SAFE_UNSUPPORTED: 400,
                  BAD_AGENT_EXECUTABLE: 400, BAD_AGENT_PROFILE: 400,
                  BAD_ASSET: 400, ASSET_TOO_LARGE: 413, ASSET_MISSING: 404,
                  REFUSAL: 422, EMPTY: 502 };
    const code = map[e.code] || (e.status >= 400 && e.status < 600 ? e.status : 500);
    console.error(`[err] ${req.method} ${path} → ${code}: ${e.message}`);
    return json(res, code, { error: e.message, code: e.code });
  }
});

db.open();
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${cfg.port} 已被占用。若 ContextFlow 已在运行，直接回扩展验证连接，不要重复启动；否则检查占用该端口的应用。`
    : `ContextFlow 服务启动失败：${error.message}`);
  process.exitCode = 1;
});
server.listen(cfg.port, '127.0.0.1', () => {
  const s = db.stats(cfg.sync.backend);
  console.log(`ContextFlow 服务 → http://127.0.0.1:${cfg.port}`);
  console.log(`  配置 ${CONFIG_PATH}`);
  console.log(`  库内 ${s.total} 条事件 / ${s.articles} 篇文章，待同步 ${s.unsynced}`);
  console.log(`  翻译 ${cfg.translate.provider} · ${cfg.translate.model}`
    + ` · ${cfg.translate.apiKey ? 'key 已配置' : '⚠ 无 key，/translate 返回 503'}`);
  console.log(`  同步 ${describe(cfg)}`);
  const exts = cfg.allowedOrigins.filter((o) => EXT_ORIGIN_RE.test(o));
  if (exts.length) console.log(`  扩展 ${exts.join(', ')}`);
  console.log(cfg.allowAnyOrigin
    ? `  来源 所有 origin（allowAnyOrigin=true）· token 校验${cfg.requireToken ? '已开启' : ' ⚠ 未开启：任何网页都可读写'}`
    : `  来源 白名单 ${cfg.allowedOrigins.join(', ')}`);
});

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`[server] 收到 ${signal}，正在停止…`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  jobs.shutdown();
  try {
    // 等 Codex 子进程退出后再结束父进程，保留超时升级 SIGKILL 的机会。
    await Promise.all([
      closeAgents(),
      new Promise(resolve => server.close(resolve)),
    ]);
    clearTimeout(force);
    process.exit(0);
  } catch (error) {
    console.error('[server] 停止失败：', error.message);
    process.exit(1);
  }
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
// Private parent IPC permits graceful shutdown on Windows too.
process.on('message', message => { if (message?.type === 'contextflow-shutdown') shutdown('desktop'); });
process.on('disconnect', () => { if (desktopToken) shutdown('desktop-disconnected'); });
