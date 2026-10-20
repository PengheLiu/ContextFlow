// LLM 调用的共用底座：翻译与解释都走这里。
//
// 后端可在面板配置界面切换：
//   provider='openai'    → OpenAI 兼容网关（/v1/chat/completions），默认
//   provider='anthropic' → 官方 SDK，baseUrl 可指向自建/内网兼容网关
//
// think 模式在这里统一处理：各家参数完全不同（Anthropic 4.6+ 只认 adaptive、
// 4.5 代只认 budget_tokens、OpenAI 系是 reasoning_effort、部分国产网关是
// enable_thinking），所以做成"依次尝试 + 被拒则降级"，开关绝不会把请求搞挂。
import Anthropic from '@anthropic-ai/sdk';

export const err = (msg, code) => Object.assign(new Error(msg), { code });

/** 去掉末尾 /v1，各家 SDK/接口自己会补 */
export const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '')
  .replace(/\/(?:chat\/completions|messages|models)$/, '').replace(/\/v1$/, '');

function validateBase(t) {
  if (!t.baseUrl && t.provider === 'anthropic') return;
  if (!t.baseUrl) throw err('OpenAI 兼容模式必须填 Base URL（模型服务地址，不是本机配对地址）', 'NO_BASEURL');
  try {
    const url = new URL(t.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid');
  } catch { throw err('Base URL 请填写 http:// 或 https:// 开头的模型服务地址，不要填写控制台页面、密钥或带查询参数的链接', 'NO_BASEURL'); }
}

/** 临时连接草稿：只允许模型连接字段，不修改配置，也不回传已有密钥。 */
export function modelDraft(cfg, body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err('模型连接草稿格式不正确', 'BAD_CONFIG');
  const draft = body.translate;
  if (draft === undefined) return cfg;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw err('模型连接草稿格式不正确', 'BAD_CONFIG');
  const translate = { ...cfg.translate };
  for (const key of ['provider', 'baseUrl', 'model', 'apiKey']) {
    if (!(key in draft)) continue;
    if (typeof draft[key] !== 'string') throw err('模型连接字段必须是文字', 'BAD_CONFIG');
    translate[key] = draft[key].trim();
  }
  if (!['openai', 'anthropic'].includes(translate.provider)) throw err('不支持的模型接口类型', 'BAD_CONFIG');
  validateBase(translate);
  const endpoint = (t) => trimBase(t.baseUrl || (t.provider === 'anthropic' ? 'https://api.anthropic.com' : ''));
  if (!draft.apiKey?.trim() && (translate.provider !== cfg.translate.provider || endpoint(translate) !== endpoint(cfg.translate))) {
    throw err('更换模型服务地址或接口类型后，请重新填写 API key；不会把已保存的密钥发送到新地址', 'NO_API_KEY');
  }
  return { ...cfg, translate };
}

/** 上游是否因为「不认识这个推理参数」而拒绝 */
const rejectedThinking = (e) =>
  (e?.status === 400 || e?.status === 422)
  && /thinking|budget_tokens|reasoning|effort/i.test(String(e?.message || ''));

async function viaAnthropic({ baseUrl, apiKey, model, system, messages, maxTokens, thinking, signal }) {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: trimBase(baseUrl) } : {}) });
  const base = { model, max_tokens: maxTokens, system, messages };
  // 注意：不要传 output_config.effort —— Haiku 4.5 不支持，传了直接报错。

  const attempts = thinking
    ? [{ ...base, thinking: { type: 'adaptive' } },
       { ...base, thinking: { type: 'enabled', budget_tokens: 1024 } },
       base]
    : [base];

  let res, applied = thinking, lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      res = await client.messages.create(attempts[i], { signal });
      applied = thinking && i < attempts.length - 1;
      break;
    } catch (e) {
      lastErr = e;
      if (!rejectedThinking(e)) throw e;        // 与 thinking 无关的错误照常抛
    }
  }
  if (!res) throw lastErr;

  if (res.stop_reason === 'refusal') throw err('模型拒绝了该请求', 'REFUSAL');
  // content 是 block 数组，必须按 type 过滤 —— thinking 块也在里面
  const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return {
    out,
    usage: {
      in: res.usage.input_tokens, out: res.usage.output_tokens,
      // 连续对话靠缓存命中才划算，把它透出来供界面显示 —— 否则"稳定命中
      // KV-Cache"只是个说法，没人验证得了
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    },
    truncated: res.stop_reason === 'max_tokens',
    thinking: thinking ? (applied ? 'on' : 'unsupported') : 'off',
  };
}

async function viaOpenAI({ baseUrl, apiKey, model, system, messages, maxTokens, thinking, signal }) {
  const url = `${trimBase(baseUrl)}/v1/chat/completions`;
  const send = (extra) => fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
      ...extra,
    }),
  });

  const variants = thinking
    ? [{ reasoning_effort: 'medium' }, { enable_thinking: true }, {}]
    : [{}];

  let res, body, applied = thinking;
  for (let i = 0; i < variants.length; i++) {
    res = await send(variants[i]);
    body = await res.json().catch(() => ({}));
    if (res.ok) { applied = thinking && i < variants.length - 1; break; }
    const msg = String(body?.error?.message || '');
    const paramIssue = (res.status === 400 || res.status === 422)
      && /reasoning|thinking|unrecognized|unsupported|unknown/i.test(msg);
    if (!paramIssue) throw err(`网关返回 ${res.status}：${msg || '未知错误'}`, 'UPSTREAM');
  }
  if (!res.ok) throw err(`网关返回 ${res.status}：${body?.error?.message || '未知错误'}`, 'UPSTREAM');

  const out = (body.choices?.[0]?.message?.content || '').trim();
  const u = body.usage || {};
  return {
    out,
    usage: {
      in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0,
      // DeepSeek 等 OpenAI 兼容网关用 prompt_cache_hit_tokens 报缓存命中
      cacheRead: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u.prompt_cache_miss_tokens ?? 0,
    },
    truncated: body.choices?.[0]?.finish_reason === 'length',
    thinking: thinking ? (applied ? 'on' : 'unsupported') : 'off',
  };
}

/** 配置齐备性检查，错误信息要能直接指导用户去哪里补 */
export function requireLLM(cfg) {
  const t = cfg.translate;                       // 翻译与解释共用同一份后端配置
  if (!t.apiKey) throw err('未配置 API key：在面板「配置」里填写，或设置环境变量 ANTHROPIC_API_KEY', 'NO_API_KEY');
  if (!t.model) throw err('未配置模型名：在面板「配置」里点「获取可选模型」挑一个', 'NO_MODEL');
  validateBase(t);
  return t;
}

/**
 * 统一入口。
 * @param {object} o
 * @param {string} [o.user]      单轮便捷写法
 * @param {Array}  [o.messages]  连续对话；给了就用它，前缀恒定才能命中缓存
 * @returns {{out, usage, truncated, thinking, model}}
 */
export async function chat({ cfg, system, user, messages, maxTokens = 2048, signal }) {
  const t = requireLLM(cfg);
  const msgs = messages?.length ? messages : [{ role: 'user', content: user }];
  const args = {
    baseUrl: t.baseUrl, apiKey: t.apiKey, model: t.model,
    system, messages: msgs, maxTokens, thinking: !!t.thinking, signal,
  };
  const r = t.provider === 'openai' ? await viaOpenAI(args) : await viaAnthropic(args);
  if (!r.out) throw err('模型返回空内容', 'EMPTY');
  return { ...r, model: t.model };
}

export async function testConnection(cfg) {
  try {
    const result = await chat({ cfg: { ...cfg, translate: { ...cfg.translate, thinking: false } }, system: 'This is a connection check. Reply only OK.', user: 'OK', maxTokens: 128, signal: AbortSignal.timeout(15000) });
    return { ok: true, model: result.model };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw err('模型连接测试超时，请检查服务地址或网络后重试', 'UPSTREAM');
    throw error;
  }
}

/** 「一键获取可选模型」：拉取上游模型列表 */
export async function listModels(cfg) {
  const t = cfg.translate;
  if (!t.apiKey) throw err('先填 API key 再获取模型列表', 'NO_API_KEY');
  validateBase(t);
  const base = trimBase(t.baseUrl);
  const signal = AbortSignal.timeout(15000);
  try {
    let out;
    if (t.provider === 'openai') {
      const res = await fetch(`${base}/v1/models`, { signal, headers: { Authorization: `Bearer ${t.apiKey}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw err(`网关返回 ${res.status}：${body?.error?.message || ''}`, 'UPSTREAM');
      if (!Array.isArray(body.data)) throw err('模型服务未返回有效的模型列表，也可手动填写模型名称', 'UPSTREAM');
      out = body.data.map((m) => m?.id);
    } else {
      const client = new Anthropic({ apiKey: t.apiKey, ...(base ? { baseURL: base } : {}) });
      out = [];
      for await (const m of client.models.list({ limit: 100 }, { signal })) out.push(m.id);
    }
    return [...new Set(out.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean))].sort();
  } catch (error) {
    if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw err('获取模型列表超时，请检查服务地址或网络后重试', 'UPSTREAM');
    throw error;
  }
}
