// 划词查询：翻译与解释。
//
// 两者的后端刻意不同，这是实测后的取舍：
//
//   translate → LLM。翻译一句话不需要 agent loop，没有任何工具帮得上忙。
//               实测同一句话走 agent 是 $0.28 / 5.8s，走 deepseek-flash 是
//               近乎免费 / 2~3s。贵一到两个数量级换零收益。
//   explain   → 可选 LLM 或**本地 agent**。agent 的价值不是"更聪明的模型"，
//               而是它能读你本地积累的语料：实测它自己去翻笔记库，答出
//               "…这正好对应你在 attacker's server 旁批的「可行性如何呢」"
//               —— 这是任何网页版 LLM 都做不到的。
//               代价：18s / 2 轮 / $0.036（全文由浏览器提供时）。若让它自己去
//               WebFetch 探索则是 32s / 10 轮 / $0.44 —— 差一个数量级，这就是
//               "正文由浏览器给"而不是"让 agent 自己抓"的实测依据。
//               无论哪种都不能同步等在 HTTP 上，所以走异步作业（jobs.mjs）。
//
// 两者都走**同一篇文章的连续对话**（convo.mjs）：全文作首条消息、之后只在末尾
// 追加。前缀恒定 → 稳定命中 prompt cache；有全文上下文 → 术语一致、代词能解、
// 不必让 agent 再去抓一遍页面。
import { createHash } from 'node:crypto';
import { chat, err } from './llm.mjs';
import * as db from './db.mjs';
import * as agent from './agent.mjs';
import { buildMessages, agentPrompt, flatten } from './convo.mjs';

const MAX_INPUT = 5000;        // 防误选全文烧钱
const MAX_QUESTION = 1000;
const MAX_ARTICLE = 400000;    // 全文上限（字符）；再长就不带上下文了
const CACHE_CAP = 500;

// 同一段反复查不重复计费。注意：连续对话下命中率会下降（历史在变），
// 所以缓存键里必须带上历史轮数，否则会拿旧上下文的答案糊弄新问题。
const cache = new Map();

function cached(key) {
  if (!cache.has(key)) return null;
  const hit = cache.get(key);
  cache.delete(key); cache.set(key, hit);        // LRU 触碰
  return hit;
}
function remember(key, val) {
  cache.set(key, val);
  if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
}

const checkText = (text) => {
  const src = String(text ?? '').trim();
  if (!src) throw err('text 为空', 'BAD_INPUT');
  if (src.length > MAX_INPUT) throw err(`选中文本 ${src.length} 字符，超过 ${MAX_INPUT} 上限`, 'TOO_LONG');
  return src;
};

export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

/**
 * 取该文章的全文（用于连续对话的首条消息）。
 * 没有就返回 null —— 调用方据此告诉客户端"把正文传上来"。
 */
function articleOf(urlKey) {
  const row = db.getArticleText(urlKey);
  if (!row?.text) return null;
  return { title: row.title, url: row.url, text: row.text, hash: row.hash };
}

/** 前端上传正文。浏览器手里本来就有，不必让 agent 再抓一遍。 */
export function putArticle({ urlKey, title, url, text }) {
  const body = String(text ?? '').trim();
  if (!urlKey) throw err('缺少 urlKey', 'BAD_INPUT');
  if (!body) throw err('正文为空', 'BAD_INPUT');
  const clipped = body.length > MAX_ARTICLE ? body.slice(0, MAX_ARTICLE) : body;
  const hash = sha1(clipped);
  const prev = db.getArticleText(urlKey);
  if (prev?.hash === hash) return { hash, changed: false, chars: clipped.length };

  db.putArticleText(urlKey, { hash, title, url, text: clipped });
  // 正文变了（改版 / 懒加载补齐）→ agent 那边的会话上下文已经过时，重开
  for (const id of agent.AGENT_IDS) db.dropAgentSession(urlKey, id);
  return { hash, changed: true, chars: clipped.length, truncated: clipped.length < body.length };
}

// ---------------- 翻译（LLM，同步） ----------------

const translateSystem = (target) =>
  `You are a translation engine. Translate the user's selected text into ${target}.
The conversation may contain the full article for context — use it for terminology
consistency and pronoun resolution, but translate ONLY the text in the latest message.
Output ONLY the translation — no explanation, no quotes, no romanization, no preamble.
Preserve inline code, LaTeX/math, URLs, and proper nouns verbatim.
If the text is already in ${target}, output it unchanged.`;

export async function translate({ text, target, urlKey, offset, fresh = false, cfg }) {
  const src = checkText(text);
  const t = cfg.translate;
  const lang = target || t.target;

  // 本地 QA 缓存：同一段同一目标语言译过就直接给，不再打上游
  if (urlKey && !fresh) {
    const prior = db.findLookup(urlKey, { action: 'translate', text: src, extra: { target: lang } });
    if (prior) {
      return { translation: prior.value, target: lang, cached: 'local', model: t.model,
        ctx: { hasArticle: true, turns: 0, dropped: 0, tokens: 0, cachedAt: prior.createdAt } };
    }
  }

  // chunkChars 兼作开关：0 表示不带正文上下文。一个数值胜过"布尔位 + 长度"
  // 两个真值来源 —— 后者总会出现"开着但长度为 0"这类自相矛盾的组合。
  const chunkChars = t.chunkChars ?? 5000;
  const withCtx = chunkChars > 0;
  const article = withCtx && urlKey ? articleOf(urlKey) : null;
  const history = withCtx && urlKey ? db.lookupHistory(urlKey, 'translate') : [];

  const draft = { action: 'translate', text: src, offset, extra: { target: lang } };
  const { messages, tokens, dropped, hasArticle, chunks, totalChunks } = buildMessages({
    article, history, current: draft,
    budget: t.contextBudget || 60000, chunkChars,
  });

  const key = sha1([
    'tr', t.provider, t.model, t.thinking ? 'think' : 'plain', lang,
    article?.hash || '-', history.length, chunks, src,
  ].join('|'));
  // 缓存整个结果形状而不只是译文 —— 只缓存字符串会让命中分支缺少 ctx/usage，
  // 前端读 ctx.chunks 直接抛错（踩过）
  const hit = cached(key);
  if (hit) return { ...hit, cached: true };

  const r = await chat({
    cfg, system: translateSystem(lang), messages,
    maxTokens: t.thinking ? 4096 : 2048,
  });
  const out = {
    translation: r.out, target: lang, cached: false,
    usage: r.usage, truncated: r.truncated, thinking: r.thinking, model: r.model,
    ctx: { hasArticle, turns: history.length, dropped, tokens, chunks, totalChunks,
      truncated: !!article && article.text.length >= MAX_ARTICLE },
  };
  remember(key, out);
  return out;
}

// ---------------- 解释 ----------------

const EXPLAIN_SYSTEM = `你是阅读助手。用户正在读一篇文章，选中了一段内容并就它提问。

规则：
- 直接回答，不要复述问题、不要"好的""让我们来看"这类开场
- 紧贴选中的这段内容作答，不要泛泛而谈
- 对话里可能已有全文，优先依据全文的实际内容，而不是你的先验印象
- 术语首次出现时给出中文译名与英文原文
- 若全文里确实找不到依据，明确说明缺什么，不要编造
- 用中文回答（除非用户用其他语言提问）
- 简洁：能三句说清就不要写五句`;

const AGENT_SYSTEM = `${EXPLAIN_SYSTEM}

你还有一项别的助手没有的能力：读用户自己的笔记库（只读）。
回答后，如果笔记里有与这段内容相关的记录，用一句话点出关联并给出文件名。
没有就不要提，别为了凑而凑。`;

/** 解释走 LLM（同步）*/
export async function explainViaLLM({ text, question, urlKey, offset, fresh = false, cfg }) {
  const src = checkText(text);
  const q = String(question ?? '').trim().slice(0, MAX_QUESTION);
  const t = cfg.translate;

  const prior = urlKey && !fresh
    ? db.findLookup(urlKey, { action: 'explain', text: src, extra: { question: q } }) : null;
  if (prior) {
    return { answer: prior.value, question: q, cached: 'local', via: 'llm', model: t.model,
      ctx: { hasArticle: true, turns: 0, dropped: 0, tokens: 0, cachedAt: prior.createdAt } };
  }

  const chunkChars = t.chunkChars ?? 5000;
  const article = chunkChars > 0 && urlKey ? articleOf(urlKey) : null;
  const history = urlKey ? db.lookupHistory(urlKey, 'explain') : [];
  const draft = { action: 'explain', text: src, offset, extra: { question: q } };
  const { messages, tokens, dropped, hasArticle, chunks, totalChunks } = buildMessages({
    article, history, current: draft,
    budget: t.contextBudget || 60000, chunkChars: chunkChars || 5000,
  });

  const key = sha1(['ex', t.provider, t.model, t.thinking ? 'think' : 'plain',
    article?.hash || '-', history.length, chunks, q, src].join('|'));
  const hit = cached(key);
  if (hit) return { ...hit, cached: true };

  const r = await chat({ cfg, system: EXPLAIN_SYSTEM, messages, maxTokens: t.thinking ? 4096 : 1500 });
  const out = {
    answer: r.out, question: q, cached: false, via: 'llm',
    usage: r.usage, truncated: r.truncated, thinking: r.thinking, model: r.model,
    ctx: { hasArticle, turns: history.length, dropped, tokens, chunks, totalChunks,
      truncated: !!article && article.text.length >= MAX_ARTICLE },
  };
  remember(key, out);
  return out;
}

/**
 * 解释走本地 agent。**耗时几十秒**，由调用方放进 jobs 队列，不要同步等。
 * @param {(s:string)=>void} [onProgress]
 */
export async function explainViaAgent({ text, question, urlKey, offset, fresh = false, cfg, onProgress }) {
  const src = checkText(text);
  const q = String(question ?? '').trim().slice(0, MAX_QUESTION);

  // 先查本地。agent 一次几十秒，重复问同一句话再等一遍毫无道理。
  const prior = urlKey && !fresh
    ? db.findLookup(urlKey, { action: 'explain', text: src, extra: { question: q } }) : null;
  if (prior) {
    onProgress?.('本地已有答案，直接返回');
    return { answer: prior.value, question: q, cached: 'local', via: 'local-cache',
      model: '本地缓存', ctx: { hasArticle: true, turns: 0, dropped: 0, tokens: 0,
        cachedAt: prior.createdAt } };
  }
  const a = cfg.agent || {};
  const id = a.id;
  if (!agent.AGENT_IDS.includes(id)) {
    throw err(`未选择本地 agent（在面板「配置」里选一个并点检测）`, 'NO_AGENT');
  }

  const article = (cfg.translate?.chunkChars ?? 5000) > 0 && urlKey ? articleOf(urlKey) : null;
  const sess = urlKey ? db.getAgentSession(urlKey, id) : null;

  const chunkChars = cfg.translate?.chunkChars ?? 5000;
  const draft = { action: 'explain', text: src, offset, extra: { question: q } };
  const canResume = agent.AGENTS[id].resumable && !!sess;

  let prompt, chunks, note, turnsIncluded = sess?.turns || 0;
  if (canResume) {
    // 会话在 agent 那边，只补差量：本次选区需要的段落里尚未发过的那些
    const r0 = agentPrompt({ article, current: draft, loaded: sess.loadedChunks || 0, chunkChars });
    prompt = r0.prompt; chunks = r0.chunks;
    const added = chunks - (sess.loadedChunks || 0);
    note = added > 0 ? `选区超出已加载范围，补 ${added} 段正文…` : '续接会话…';
  } else {
    // 不能续接（agent 不支持，或还没有会话）→ 发完整对话。
    // 只发增量会让没有记忆的 agent 在缺上下文的情况下作答。
    const history = urlKey ? db.lookupHistory(urlKey, 'explain') : [];
    const built = buildMessages({
      article, history, current: draft,
      budget: cfg.translate?.contextBudget || 60000, chunkChars,
    });
    prompt = flatten(built.messages);
    chunks = built.chunks;
    turnsIncluded = Math.max(0, history.length - built.dropped);
    note = agent.AGENTS[id].resumable ? '首次提问：交出正文与历史…'
      : `${agent.AGENTS[id].label} 不支持会话续接，每次发完整对话…`;
  }
  prompt = `${canResume ? '' : `${AGENT_SYSTEM}\n\n---\n\n`}${prompt}`;
  onProgress?.(note);

  const r = await agent.run({
    agent: id,
    prompt,
    sessionId: sess?.sessionId,
    resume: canResume,
    notesDir: a.notesDir || '',
    maxTurns: a.maxTurns || 12,
    timeoutMs: a.timeoutMs || 240000,
    env: a.env || {},
    // stderr 里混着上游的警告与调试行，它们不是"进度"。只放行看起来像
    // 工具活动的行，否则浮层上会一直挂着一句无关的 warning。
    onProgress: (s) => {
      const line = String(s).split('\n').map((x) => x.trim())
        .filter((x) => x && !/^(warning|warn|deprecat|permission deny rule)/i.test(x))
        .pop();
      if (line) onProgress?.(line.slice(0, 120));
    },
  });

  if (urlKey && r.sessionId) {
    db.putAgentSession(urlKey, id, r.sessionId, (sess?.turns || 0) + 1, chunks);
  }
  // 只在真有数字时才给 usage —— 之前硬编 {in:0,out:0}，面板上就显示成
  // "0→0 tok"，看起来像"一个 token 都没用"，是在撒谎。dsh 这类不报用量的
  // agent 应该干脆不显示这一项。
  const usage = (r.cacheRead || r.cacheWrite)
    ? { in: 0, out: 0, cacheRead: r.cacheRead ?? 0, cacheWrite: r.cacheWrite ?? 0 }
    : undefined;
  return {
    answer: r.answer, question: q, cached: false, via: `agent:${id}`,
    model: agent.AGENTS[id].label,
    ...(usage ? { usage } : {}),
    agentMeta: {
      turns: r.turns, ms: r.ms, costUsd: r.costUsd, denials: r.denials,
      resumed: canResume,
    },
    ctx: {
      hasArticle: !!article, turns: turnsIncluded, dropped: 0, tokens: 0,
      chunks, totalChunks: article ? Math.ceil(article.text.length / chunkChars) : 0,
      truncated: !!article && article.text.length >= MAX_ARTICLE,
    },
  };
}

/** 解释的统一入口：按配置分派。返回 {mode:'sync'|'job'} 供路由决定怎么回应。 */
export function explainMode(cfg) {
  return cfg.explain?.backend === 'agent' ? 'job' : 'sync';
}

export const LOOKUP_LIMITS = { MAX_INPUT, MAX_QUESTION, MAX_ARTICLE };
