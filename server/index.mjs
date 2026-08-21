// 本地服务：只 bind 127.0.0.1，零外部依赖（除翻译用的官方 Anthropic SDK）。
//
// 安全模型（DESIGN.md §0）：脚本跑在页面 MAIN world，服务端无法区分我方脚本
// 与恶意页面的请求，因此防线是两条，而不是 token：
//   1. CORS 只放行白名单 origin  → 非白名单站点读不到响应
//   2. 强制要求自定义头 X-ContextFlow   → 任何跨源请求都必须预检，预检失败则请求根本不发出。
//      少了这条，Content-Type: text/plain 的「简单请求」POST 能绕过 CORS 往库里写垃圾。
import { createServer } from 'node:http';
import { loadConfig, saveConfig, publicView, CONFIG_PATH } from './config.mjs';
import * as db from './db.mjs';
import * as lookup from './lookup.mjs';
import { listModels } from './llm.mjs';
import { listNotebooks, listPaths } from './siyuan.mjs';
import { syncAll, describe, BACKENDS } from './sync.mjs';
import * as jobs from './jobs.mjs';
import { originAllowed, EXT_ORIGIN_RE } from './origin.mjs';
import { detect as detectAgents } from './agent.mjs';
import { detectVaults, listFolders } from './obsidian.mjs';

let cfg = loadConfig();   // POST /config 会热替换
const MAX_BODY = 2 * 1024 * 1024;

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
};

const rejected = new Set();   // 同一 origin 只提示一次，避免刷屏

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // 无 Origin：curl / 同源，放行
  if (!originAllowed(cfg, origin)) {
    if (!rejected.has(origin)) {
      rejected.add(origin);
      console.warn(`[cors] 拒绝 ${origin}\n`
        + `       要允许它：把 "${origin}" 加入 ${CONFIG_PATH} 的 allowedOrigins（支持 * 通配符），然后重启服务`);
    }
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ContextFlow, X-Ctxit, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' })); req.destroy(); return; }
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
  if (cfg.requireToken) {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (tok !== cfg.token) return json(res, 401, { error: 'token 无效' });
  }

  try {
    if (path === '/health') {
      return json(res, 200, { ok: true, stats: db.stats(cfg.sync.backend),
        hasApiKey: !!cfg.translate.apiKey, backend: cfg.sync.backend, backends: BACKENDS });
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

    if (path.startsWith('/events/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/events/'.length));
      return json(res, 200, { ok: db.softDelete(id) });
    }

    if (path === '/translate' && req.method === 'POST') {
      const { text, target, urlKey, offset, fresh } = await readBody(req);
      return json(res, 200, await lookup.translate({ text, target, urlKey, offset, fresh, cfg }));
    }

    // 前端上传正文，供连续对话作首条消息。浏览器手里本来就有正文，
    // 让 agent 再抓一遍既慢又多一个失败点。
    if (path === '/article' && req.method === 'POST') {
      const { urlKey, title, url: src, text } = await readBody(req);
      return json(res, 200, lookup.putArticle({ urlKey, title, url: src, text }));
    }

    if (path === '/explain' && req.method === 'POST') {
      const { text, question, urlKey, offset, fresh } = await readBody(req);
      if (lookup.explainMode(cfg) === 'sync') {
        return json(res, 200, await lookup.explainViaLLM({ text, question, urlKey, offset, fresh, cfg }));
      }
      // agent 路径实测 10 轮 / 32 秒，不能同步等在 HTTP 上：立刻回 jobId，前端轮询
      const job = jobs.submit({
        kind: 'explain',
        label: String(text ?? '').slice(0, 40),
        task: (api) => lookup.explainViaAgent({
          text, question, urlKey, offset, fresh, cfg, onProgress: api.progress,
        }),
      });
      return json(res, 202, { job, mode: 'job' });
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
      return json(res, 200, { agents: await detectAgents(fresh), jobs: jobs.stats() });
    }

    // ---- 配置界面 ----
    if (path === '/config' && req.method === 'GET') {
      return json(res, 200, publicView(cfg));
    }
    if (path === '/config' && req.method === 'POST') {
      const patch = await readBody(req);
      cfg = saveConfig(patch);            // 落盘并热替换内存态
      console.log('[config] 已更新：' + Object.keys(patch).join(', '));
      return json(res, 200, publicView(cfg));
    }
    if (path === '/llm/models' && req.method === 'GET') {
      return json(res, 200, { models: await listModels(cfg) });
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
      const out = await syncAll(cfg, urlKey ? { urlKey } : {});
      const where = (out.files || out.docs || []).join(', ') || '(无变化)';
      console.log(`[sync] ${out.backend} · ${out.articles} 篇 · 新增 ${out.inserted}`
        + ` / 改写 ${out.updated} → ${where}`);
      return json(res, 200, out);
    }

    return json(res, 404, { error: `无此路由 ${req.method} ${path}` });
  } catch (e) {
    const map = { NO_AGENT: 503, AGENT_SPAWN: 503, AGENT_TIMEOUT: 504,
                  AGENT_EMPTY: 502, AGENT_ERROR: 502, AGENT_PARSE: 502, BAD_AGENT: 400,
                  NO_API_KEY: 503, TOO_LONG: 413, BAD_INPUT: 400, BAD_JSON: 400,
                  TOO_LARGE: 413, SIYUAN_DOWN: 503, SIYUAN_AUTH: 503, SIYUAN: 502,
                  NO_MODEL: 503, NO_BASEURL: 503, UPSTREAM: 502,
                  NO_TARGET: 503, BAD_TARGET: 400, BAD_BACKEND: 400, REFUSAL: 422, EMPTY: 502 };
    const code = map[e.code] || (e.status >= 400 && e.status < 600 ? e.status : 500);
    console.error(`[err] ${req.method} ${path} → ${code}: ${e.message}`);
    return json(res, code, { error: e.message, code: e.code });
  }
});

db.open();
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
