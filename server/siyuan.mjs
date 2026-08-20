// 思源同步：**一篇文章一个文档**，四类记录各一个标题，日报只留索引。
//
// 从"按天汇总"改过来的原因：跨天读同一篇会被切成两半（实测 21 条高亮在
// 08-19 的文档、6 条解释在 08-20 的文档），看起来就像同步丢了东西。
//
// 幂等是这一块的全部难点 —— 重复点同步绝不能产生重复块。四道保障：
//   1. 文档层：urlKey → docId 记在本地 artdoc 表（不依赖思源 SQL 索引，它建
//      文档后有延迟），并给文档打 custom-contextflow-urlkey 属性，库丢了能反查
//   2. 标题层：(urlKey, category) → blockId 记在本地 heads 表
//   3. 事件层：只处理"未同步"或"同步后改过"的事件
//   4. 内容层：已同步的块内容变了走 updateBlock **原地改**，不追加第二份 ——
//      总结和评论是会被反复编辑的，追加等于笔记里出现两个版本
//
// 两个反直觉的内核行为（实测踩出来，改动时别丢）：
//   · 标题是 leaf block，内容只能用 previousID 逐块串在它后面，不能 parentID
//   · insertBlock 只给 parentID 是插到**开头**，追加到末尾必须用 previousID
import * as db from './db.mjs';
import { LABEL_OF, groupByCategory, docName, contentHash } from './layout.mjs';

class SiYuanError extends Error {
  constructor(msg, code) { super(msg); this.code = code ?? 'SIYUAN'; }
}

export function makeClient({ origin, token }) {
  return async function call(path, payload = {}) {
    let res;
    try {
      res = await fetch(origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new SiYuanError(`连不上思源内核 ${origin}：${e.message}（思源没开？）`, 'SIYUAN_DOWN');
    }
    const raw = await res.text();
    if (!raw.trim()) {
      // 思源对鉴权失败是「200 + 空 body」的静默拒绝，不是 401
      throw new SiYuanError(`${path} 返回空响应，通常是 token 无效`, 'SIYUAN_AUTH');
    }
    const body = JSON.parse(raw);
    if (body.code !== 0) throw new SiYuanError(`${path}: ${body.msg || `code ${body.code}`}`);
    return body.data;
  };
}

/** insertBlock 的返回结构较深，新块 id 藏在 doOperations 里 */
const newBlockId = (data) => data?.[0]?.doOperations?.[0]?.id ?? null;

/** 在 previousID 之后插一块。失败返回 null（由调用方决定是否降级重试）。 */
async function insertAfter(call, markdown, previousID) {
  try {
    return newBlockId(await call('/api/block/insertBlock',
      { dataType: 'markdown', data: markdown, previousID }));
  } catch {
    return null;
  }
}

/** 原地改写已有块。块被用户手工删掉时返回 false，由调用方退回插入。 */
async function updateBlock(call, id, markdown) {
  try {
    await call('/api/block/updateBlock', { dataType: 'markdown', data: markdown, id });
    return true;
  } catch {
    return false;
  }
}

const mdEscape = (s) => String(s ?? '').replace(/[[\]]/g, '\\$&');
const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚间标注会落到前一天） */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 同步全部待同步文章，每篇写入自己的文档。
 *
 * @param {object} cfg
 * @param {{call?:function, urlKey?:string}} [opts] call 可注入（测试用假内核）
 * @returns {{articles, inserted, updated, docs, details}}
 */
export async function syncAll(cfg, opts = {}) {
  const { origin, token, notebookId, docPathPrefix } = cfg.siyuan;
  if (!token && !opts.call) {
    throw new SiYuanError('未配置 siyuan.token（见 ~/.contextflow/config.json）', 'SIYUAN_AUTH');
  }
  const call = opts.call || makeClient({ origin, token });

  const all = db.articlesToSync('siyuan');
  const articles = opts.urlKey ? all.filter((a) => a.urlKey === opts.urlKey) : all;

  let inserted = 0, updated = 0;
  const details = [];
  const docs = [];

  for (const art of articles) {
    const r = await syncArticle(call, { art, notebookId, docPathPrefix });
    inserted += r.inserted; updated += r.updated;
    if (r.inserted || r.updated) docs.push(r.docId);
    details.push({ urlKey: art.urlKey, title: art.title, ...r });
  }
  return { articles: articles.length, inserted, updated, docs, details };
}

async function syncArticle(call, { art, notebookId, docPathPrefix }) {
  const docId = await ensureArticleDoc(call, { art, notebookId, docPathPrefix });
  const events = db.eventsForArticle(art.urlKey, 'siyuan');
  let inserted = 0, updated = 0;

  for (const [catKey, group] of groupByCategory(events)) {
    let head = null;      // 延迟到确有内容要写时才建标题，避免留空标题

    for (const ev of group) {
      const md = render(ev);
      if (!md) continue;
      const hash = contentHash(md);

      // 已同步过：内容没变就跳过，变了就原地改
      if (ev.syncedRef && ev.syncedHash === hash) continue;
      if (ev.syncedRef) {
        if (await updateBlock(call, ev.syncedRef, md)) {
          db.markSynced(ev.id, 'siyuan', ev.syncedRef, hash);
          updated++;
          continue;
        }
        // 块被用户在思源里删了，退回插入
        console.warn(`[sync] 块 ${ev.syncedRef} 已不存在，改为重新插入`);
      }

      if (!head) head = await ensureHead(call, { docId, art, catKey });
      let prev = head.cursor, atCursor = true;

      // 后补的评论要插到它自己那条高亮之后，而不是分类末尾
      if (ev.action === 'comment') {
        const host = blockIdOf(events, ev.parentId) ?? db.blockIdOfEvent(ev.parentId);
        if (host && host !== head.cursor) { prev = host; atCursor = false; }
      }

      let id = await insertAfter(call, md, prev);
      if (!id && prev !== head.blockId) {
        // previousID 失效（用户在思源里手工删过块）→ 退回到标题后
        console.warn(`[sync] previousID ${prev} 失效，退回标题后插入`);
        id = await insertAfter(call, md, head.blockId);
        atCursor = true;
      }
      if (!id) throw new SiYuanError(`insertBlock 未返回块 id（event ${ev.id}）`);

      db.markSynced(ev.id, 'siyuan', id, hash);
      ev.siyuanBlockId = id;            // 供同批次的评论定位
      if (atCursor) head.cursor = id;
      inserted++;
    }
    if (head) db.putHead(art.urlKey, 'siyuan', catKey, head.blockId, head.cursor);
  }

  if (inserted || updated) await writeIndex(call, { art, notebookId, docPathPrefix, docId });
  return { docId, inserted, updated };
}

/**
 * 文章文档：artdoc 表 → 块属性反查 → 新建。三级回落缺一不可 ——
 * 少了属性反查，换机/删库后会给同一篇文章重复建文档。
 */
async function ensureArticleDoc(call, { art, notebookId, docPathPrefix }) {
  const known = db.getArtDoc(art.urlKey, 'siyuan');
  if (known) return known;                       // 空串是被重置过的坏落点，当作没有

  // 反查必须限定 b.type='d'（文档块）。
  //
  // 按天汇总时代，这个属性打在**日报里的文章标题块**上；不限定类型的话会把那个
  // 标题块当成文档 id，接着用 parentID 往标题里插内容 —— 思源直接报
  // "heading is a leaf block and cannot have children"。真机才暴露得出来。
  //
  // 同时认改名前的 custom-ctxit-urlkey：已写进用户思源里的旧文档只带旧属性名。
  const rows = await call('/api/query/sql', {
    stmt: 'SELECT a.block_id FROM attributes a JOIN blocks b ON b.id = a.block_id'
      + " WHERE a.name IN ('custom-contextflow-urlkey','custom-ctxit-urlkey')"
      + ` AND a.value='${sqlLit(art.urlKey)}' AND b.type='d' LIMIT 1`,
  });
  let id = rows?.[0]?.block_id;

  if (!id) {
    // 同名冲突要问内核，不能查 artdoc —— 思源那边存的是 docId，拿不到文档名。
    // 不处理的话两篇同名文章会挤进同一个 hpath，内容混在一起。
    const occupied = async (n) => {
      const r = await call('/api/query/sql', {
        stmt: `SELECT id FROM blocks WHERE type='d' AND box='${sqlLit(notebookId)}'`
          + ` AND hpath='${sqlLit(`${docPathPrefix}/${n}`)}' LIMIT 1`,
      });
      return !!r?.[0]?.id;
    };
    let name = docName(art.title, art.urlKey);
    if (await occupied(name)) name = docName(art.title, art.urlKey, () => true);
    const hpath = `${docPathPrefix}/${name}`;
    id = await call('/api/filetree/createDocWithMd',
      { notebook: notebookId, path: hpath, markdown: '' });
    if (!id) throw new SiYuanError(`创建文档失败：${art.urlKey}`);
    await call('/api/attr/setBlockAttrs', {
      id,
      attrs: {
        'custom-contextflow-urlkey': art.urlKey,
        'custom-contextflow-url': art.url || '',
        'custom-contextflow-first-read': art.firstDay,
      },
    });
  }
  db.putArtDoc(art.urlKey, 'siyuan', id);
  return id;
}

/**
 * 分类标题块。返回 { blockId, cursor } —— cursor 是"上一块"，
 * 跨同步批次靠它接着往后插（标题是 leaf block，只能这样串）。
 */
async function ensureHead(call, { docId, art, catKey }) {
  const local = db.getHead(art.urlKey, 'siyuan', catKey);
  if (local) return { blockId: local.blockId, cursor: local.lastBlockId || local.blockId };

  const md = `## ${LABEL_OF.get(catKey)}`;
  // insertBlock 只给 parentID 是插到开头，所以四个标题按建立顺序会**倒序**排。
  // 用已存在的最后一个标题的游标作 previousID，才能保持 CATEGORIES 的顺序。
  const prev = lastHeadCursor(art.urlKey, catKey);
  let id = prev ? await insertAfter(call, md, prev) : null;
  if (!id) {
    try {
      id = newBlockId(await call('/api/block/insertBlock',
        { dataType: 'markdown', data: md, parentID: docId }));
    } catch (e) {
      // docId 不是文档（历史遗留的坏落点，比如指向了某个标题块）时会走到这里。
      // 清掉坏落点让下次自愈 —— 否则这篇文章的同步会永久卡在一句内核报错上。
      db.putArtDoc(art.urlKey, 'siyuan', '');
      throw new SiYuanError(
        `文章「${art.title || art.urlKey}」的目标文档 ${docId} 不可用（${e.message}）。`
        + '已重置该文章的落点，请再点一次同步。', 'SIYUAN_BAD_DOC');
    }
  }
  if (!id) throw new SiYuanError(`创建分类标题失败：${art.urlKey} / ${catKey}`);
  db.putHead(art.urlKey, 'siyuan', catKey, id, null);
  return { blockId: id, cursor: id };
}

/** 本分类之前那些分类里，最后一个已存在标题的游标 */
function lastHeadCursor(urlKey, catKey) {
  const order = [...LABEL_OF.keys()];
  for (const k of order.slice(0, order.indexOf(catKey)).reverse()) {
    const h = db.getHead(urlKey, 'siyuan', k);
    if (h) return h.lastBlockId || h.blockId;
  }
  return null;
}

/**
 * 日报索引：往「文章最早一条记录所在那天」的日报文档里追加一行链接。
 * 用最早那天而不是同步当天 —— 一次性补同步历史文章时才不会全挤到今天。
 */
async function writeIndex(call, { art, notebookId, docPathPrefix, docId }) {
  const hpath = `${docPathPrefix}/${art.firstDay}`;
  // 按 hpath 查，不按 day —— 只按 day 会在改了 docPathPrefix 之后把索引行
  // 写回旧路径下的那个文档里（实测踩过一次）
  let idx = db.getIdxDoc(hpath);
  if (!idx) {
    const rows = await call('/api/query/sql', {
      stmt: `SELECT id FROM blocks WHERE type='d' AND box='${sqlLit(notebookId)}'`
        + ` AND hpath='${sqlLit(hpath)}' LIMIT 1`,
    });
    const id = rows?.[0]?.id
      || await call('/api/filetree/createDocWithMd',
        { notebook: notebookId, path: hpath, markdown: '' });
    if (!id) return;
    db.putIdxDoc(hpath, id, null);
    idx = { docId: id, tailBlockId: null };
  }

  // 该文章是否已索引过：靠属性查，不靠文本匹配（用户可能改过链接文字）
  const seen = await call('/api/query/sql', {
    stmt: "SELECT block_id FROM attributes WHERE name='custom-contextflow-idx'"
      + ` AND value='${sqlLit(art.urlKey)}' AND root_id='${sqlLit(idx.docId)}' LIMIT 1`,
  });
  if (seen?.[0]?.block_id) return;

  const title = oneLine(art.title) || art.urlKey;
  const md = `- [${mdEscape(title)}](siyuan://blocks/${docId})`;
  let id = idx.tailBlockId ? await insertAfter(call, md, idx.tailBlockId) : null;
  if (!id) {
    id = newBlockId(await call('/api/block/insertBlock',
      { dataType: 'markdown', data: md, parentID: idx.docId }));
  }
  if (!id) return;
  await call('/api/attr/setBlockAttrs',
    { id, attrs: { 'custom-contextflow-idx': art.urlKey } });
  db.putIdxDoc(hpath, idx.docId, id);
}

/** 同批次里某事件已拿到的块 id（用于把后补的评论插到它自己那条高亮之后） */
const blockIdOf = (events, id) =>
  events.find((e) => e.id === id)?.siyuanBlockId ?? null;

/**
 * 事件 → **恰好一个**思源块的 markdown。
 *
 * "恰好一个"是硬约束，不是风格偏好：insertBlock 一次只返回一个块 id，
 * 若 markdown 被解析成多块，多出来的块拿不到 id、既不在游标链上也不在
 * synced 表里 —— 实测症状是解释的原文与答案整段飘到文档末尾，只剩一行
 * 孤零零的问题留在「解释」标题下。
 *
 * 因此这里：
 *   · 嵌在块内的原文用斜体而**不用 `>`** —— `>` 会起一个引用块，
 *     后续行被它吞并或另起一块
 *   · 空行一律折叠成软换行 —— 空行是块分隔符
 * 高亮是唯一用 `>` 的，因为它整块只有原文一行。
 */
export function render(ev) {
  const v = oneBlock(ev.value);
  const src = oneLine(ev.text);
  switch (ev.action) {
    case 'highlight': return `> ${src}`;
    case 'comment': return v ? `💬 ${v}` : '';
    case 'note': return v;
    case 'translate': return v ? `*${src}*\n${v}` : '';
    case 'explain': {
      if (!v) return '';
      const q = oneLine(ev.extra?.question) || '这段在讲什么';
      return `**❓ ${q}**\n*${src}*\n${v}`;
    }
    default: return '';
  }
}

/** 折叠空行：空行是块分隔符，留着会让一个事件变成多个块 */
const oneBlock = (s) => String(s ?? '').trim().replace(/\n\s*\n+/g, '\n');

// 思源 SQL 走字符串拼接（无参数化接口），单引号必须转义，否则 urlKey/标题里的 ' 会破坏语句
const sqlLit = (s) => String(s).replace(/'/g, "''");

/** 配置界面用：可选笔记本列表 */
export async function listNotebooks(cfg) {
  const call = makeClient(cfg.siyuan);
  const d = await call('/api/notebook/lsNotebooks', {});
  return (d?.notebooks || []).filter((n) => !n.closed).map((n) => ({ id: n.id, name: n.name }));
}

/**
 * 配置界面用：某笔记本下已存在的可选父目录。
 * 思源里「目录」就是文档路径，任何文档都能有子文档，
 * 所以每个文档的每一级祖先路径都是合法的父目录。
 */
export async function listPaths(cfg, notebookId) {
  const call = makeClient(cfg.siyuan);
  const rows = await call('/api/query/sql', {
    stmt: `SELECT DISTINCT hpath FROM blocks WHERE type='d'`
      + ` AND box='${sqlLit(notebookId)}' ORDER BY hpath LIMIT 500`,
  });
  const dirs = new Set(['/']);
  for (const r of rows || []) {
    const parts = String(r.hpath || '').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) dirs.add('/' + parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}
