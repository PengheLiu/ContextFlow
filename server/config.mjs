// 配置与密钥。所有密钥只存在于本地服务，绝不进入扩展/脚本代码（DESIGN.md §1 规则 1）。
//
// 面板里的配置界面通过 GET/POST /config 读写这里。关键约束：
// GET 永不回传任何密钥明文，只回 *Set 布尔位 —— 脚本跑在页面 MAIN world，
// 回传的明文等于交给页面 JS。
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// CONTEXTFLOW_DIR 供测试指向临时目录 —— 同步层的测试要真实读写库和文件，
// 绝不能碰用户 ~/.contextflow 里的阅读记录和密钥。生产环境不设这个变量。
export const DIR = process.env.CONTEXTFLOW_DIR || join(homedir(), '.contextflow');
const LEGACY_DIR = join(homedir(), '.context_it');   // 改名前的目录
const FILE = join(DIR, 'config.json');

/**
 * 一次性迁移：把改名前的 ~/.context_it 整体搬到 ~/.contextflow。
 * 里面有 config.json（含密钥）和 context.db（阅读记录），不能丢。
 * 只在新目录尚不存在时执行，避免覆盖已有数据。
 */
function migrateLegacyDir() {
  if (existsSync(DIR) || !existsSync(LEGACY_DIR)) return;
  try {
    renameSync(LEGACY_DIR, DIR);
    console.log(`[config] 已迁移 ${LEGACY_DIR} → ${DIR}`);
  } catch (e) {
    // 跨卷等情况下 rename 会失败：退而逐个拷贝
    mkdirSync(DIR, { recursive: true });
    for (const f of readdirSync(LEGACY_DIR)) {
      try { writeFileSync(join(DIR, f), readFileSync(join(LEGACY_DIR, f))); } catch { /* 跳过 */ }
    }
    console.log(`[config] 已拷贝 ${LEGACY_DIR} → ${DIR}（旧目录保留，确认无误后可自行删除）`);
  }
}

const DEFAULTS = {
  port: 7317,
  // CORS 白名单。支持 * 通配符（只匹配单个 host 段，不跨 . / :）
  allowedOrigins: [
    'https://arxiv.org',
    'https://*.arxiv.org',
    'http://127.0.0.1:7318',
    'http://localhost:7318',
  ],
  // 放行任意 origin。⚠ 打开后白名单与强制预检两道防线同时失效，
  // 必须同时开 requireToken，否则任何网页都能读写你的全部阅读记录。
  allowAnyOrigin: false,
  requireToken: false,

  translate: {
    provider: 'openai',                       // 'openai'（OpenAI 兼容网关）| 'anthropic'
    baseUrl: '',                              // OpenAI 兼容无通用默认地址，必须显式配
    apiKey: '',                               // 留空则回退 env ANTHROPIC_API_KEY
    model: '',                                // 用配置界面「获取可选模型」挑
    target: '简体中文',
    thinking: false,                          // 开启推理模式。翻译任务通常不需要，默认关
    contextBudget: 60000,                     // 对话总 token 预算，超了从最旧的历史开始丢
    // 原文段上下文长度：正文按这个大小分段供给，只喂到覆盖当前选区为止。
    // 长文一次全塞会让第一次查询等整篇的 prefill；选区仍在已加载区域内时不追加。
    // **0 表示不带正文上下文** —— 这一个数值同时充当开关，不再另设布尔位。
    chunkChars: 5000,
  },

  // 解释的后端：'llm' 走上面那套；'agent' 走本机已装的编码 agent（异步作业）
  explain: { backend: 'llm' },

  // 本地 agent。id 由配置界面「检测」后选择
  agent: {
    id: '',                                   // claude | codex | dsh | gemini
    notesDir: '',                             // 授予**只读**访问的笔记库；空则不授权
    maxTurns: 12,
    timeoutMs: 240000,
    env: {},                                  // 需要代理时在这里给（用户的 claude 别名里就带着）
  },

  // 同步后端。加新后端见 server/sync.mjs
  sync: { backend: 'markdown' },

  obsidian: {
    vaultPath: '',                 // vault 根目录；配置界面可自动探测
    folder: '/阅读记录',
  },
  markdown: {
    dir: join(homedir(), 'ContextFlow'),   // 零依赖降级：写到普通目录
    folder: '/阅读记录',
  },

  siyuan: {
    origin: 'http://127.0.0.1:6806',
    token: '',
    notebookId: '20260729105349-c2pp9ae',     // 「每周阅读」
    docPathPrefix: '/阅读记录',
  },
};

/** 深合并（只处理一层嵌套对象，够用且可预期） */
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function readFile() {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, 'utf8')); }
  catch (e) { console.warn(`[config] ${FILE} 解析失败，忽略：${e.message}`); return {}; }
}

function write(cfg) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** 兼容早期扁平字段：anthropicApiKey / translateTarget */
function migrate(saved) {
  const t = { ...(saved.translate || {}) };
  if (!t.apiKey && saved.anthropicApiKey) t.apiKey = saved.anthropicApiKey;
  if (!t.target && saved.translateTarget) t.target = saved.translateTarget;
  const out = { ...saved, translate: t };
  // 多后端之前的配置只有 siyuan。若已配好思源 token，就不要被新的
  // markdown 默认值悄悄切走后端 —— 那会让用户以为同步坏了。
  if (!saved.sync && saved.siyuan?.token) out.sync = { backend: 'siyuan' };
  return out;
}

export function loadConfig() {
  migrateLegacyDir();
  mkdirSync(DIR, { recursive: true });
  const saved = migrate(readFile());
  const cfg = merge(DEFAULTS, saved);
  if (!cfg.token) cfg.token = randomBytes(24).toString('base64url');
  if (!existsSync(FILE) || !saved.token) write(cfg);
  // env 只作兜底，不写回文件
  if (!cfg.translate.apiKey && process.env.ANTHROPIC_API_KEY) {
    cfg.translate.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  return cfg;
}

/** 应用来自配置界面的补丁并落盘。返回新配置（内存态）。 */
export function saveConfig(patch) {
  const current = merge(DEFAULTS, migrate(readFile()));
  // 空字符串表示「不改动该密钥」，避免界面回显为空时把已存的 key 清掉
  if (patch?.translate && patch.translate.apiKey === '') delete patch.translate.apiKey;
  if (patch?.siyuan && patch.siyuan.token === '') delete patch.siyuan.token;
  const next = merge(current, patch);
  next.token = current.token;                 // 服务鉴权 token 不允许从界面改
  next.port = current.port;                   // 改端口需重启，不从界面改
  write(next);
  if (!next.translate.apiKey && process.env.ANTHROPIC_API_KEY) {
    next.translate.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  return next;
}

/** 交给前端的安全视图：不含任何密钥明文 */
export function publicView(cfg) {
  return {
    explain: { backend: cfg.explain?.backend || 'llm' },
    agent: {
      id: cfg.agent?.id || '',
      notesDir: cfg.agent?.notesDir || '',
      maxTurns: cfg.agent?.maxTurns ?? 12,
      timeoutMs: cfg.agent?.timeoutMs ?? 240000,
    },
    translate: {
      provider: cfg.translate.provider,
      baseUrl: cfg.translate.baseUrl,
      model: cfg.translate.model,
      target: cfg.translate.target,
      thinking: !!cfg.translate.thinking,
      chunkChars: cfg.translate.chunkChars ?? 5000,
      apiKeySet: !!cfg.translate.apiKey,
      apiKeyFromEnv: !cfg.translate.apiKey ? false
        : cfg.translate.apiKey === process.env.ANTHROPIC_API_KEY,
    },
    sync: { backend: cfg.sync.backend },
    obsidian: { vaultPath: cfg.obsidian.vaultPath, folder: cfg.obsidian.folder },
    markdown: { dir: cfg.markdown.dir, folder: cfg.markdown.folder },
    siyuan: {
      origin: cfg.siyuan.origin,
      notebookId: cfg.siyuan.notebookId,
      docPathPrefix: cfg.siyuan.docPathPrefix,
      tokenSet: !!cfg.siyuan.token,
    },
    security: { allowAnyOrigin: cfg.allowAnyOrigin, requireToken: cfg.requireToken },
    configPath: FILE,
  };
}

export const CONFIG_PATH = FILE;
