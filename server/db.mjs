// SQLite 是 context 事件流的唯一事实源（DESIGN.md §1 规则 2）。
// 用 Node 24 内置 node:sqlite，零外部依赖、无需原生编译。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DIR } from './config.mjs';
import { lookupKey } from '../src/core/lookupkey.js';

let db;

export function open() {
  if (db) return db;
  db = new DatabaseSync(join(DIR, 'context.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      urlKey        TEXT NOT NULL,
      url           TEXT NOT NULL DEFAULT '',
      title         TEXT NOT NULL DEFAULT '',
      action        TEXT NOT NULL,          -- highlight | comment | note
      text          TEXT,                   -- 选中的原文（highlight/comment）
      value         TEXT,                   -- 评论正文 / 笔记正文
      color         TEXT,
      anchor        TEXT,                   -- JSON，note 为 NULL
      parentId      TEXT,                   -- comment 挂在某 highlight 上
      createdAt     INTEGER NOT NULL,
      deletedAt     INTEGER,                -- 软删除，保证同步幂等
      syncedAt      INTEGER,
      siyuanBlockId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_urlkey ON events(urlKey, deletedAt);
    CREATE INDEX IF NOT EXISTS idx_events_unsynced ON events(syncedAt, deletedAt);

    -- day → 思源日报文档 id。
    -- 必须自己记：createDocWithMd 之后 SiYuan 的 blocks 索引有延迟，
    -- 若第二次同步靠 SQL 查不到就会重复建文档。
    CREATE TABLE IF NOT EXISTS docs (
      day   TEXT PRIMARY KEY,
      docId TEXT NOT NULL
    );

    -- (date, urlKey) → 思源文章分节块 id，用于按天汇总的幂等（DESIGN.md §6）
    CREATE TABLE IF NOT EXISTS sections (
      day     TEXT NOT NULL,
      urlKey  TEXT NOT NULL,
      blockId TEXT NOT NULL,
      docId   TEXT NOT NULL,
      PRIMARY KEY (day, urlKey)
    );
  `);
  // 思源的标题是 leaf block，内容只能用 previousID 逐块串在它后面，
  // 所以要记住「上一块」的 id，跨同步批次才能接着往后插。
  try { db.exec('ALTER TABLE sections ADD COLUMN lastBlockId TEXT'); }
  catch { /* 已存在 */ }
  // insertBlock 只给 parentID 是插到**开头**，要追加到末尾必须用 previousID。
  // 因此记住当天文档的尾块，新文章标题才能接在上一篇内容之后。
  try { db.exec('ALTER TABLE docs ADD COLUMN tailBlockId TEXT'); }
  catch { /* 已存在 */ }
  // 动作专属载荷（JSON）。目前只有 explain 用它存用户提的问题 ——
  // 塞进 value 会让同步渲染和列表展示都要再拆一次，不如单列干净。
  try { db.exec('ALTER TABLE events ADD COLUMN extra TEXT'); }
  catch { /* 已存在 */ }

  // 同步记录必须**按后端分开**：events.syncedAt 是单一标记，
  // 一旦从思源切到 Obsidian，旧标记会让新后端认为"全部已同步"而什么都不写。
  db.exec(`
    CREATE TABLE IF NOT EXISTS synced (
      eventId TEXT NOT NULL,
      backend TEXT NOT NULL,          -- siyuan | obsidian | markdown
      ref     TEXT,                   -- 后端内定位符：思源块 id / 文件相对路径
      at      INTEGER NOT NULL,
      PRIMARY KEY (eventId, backend)
    );
    CREATE INDEX IF NOT EXISTS idx_synced_backend ON synced(backend);

    -- (urlKey, backend) → 该文章的**唯一**目标文档。
    -- 这是"同一篇文章永远同步到同一处"的落点：一旦记下，之后不再新建文档。
    -- 按后端分开：同一篇在思源是 docId、在 Obsidian 是文件名。
    CREATE TABLE IF NOT EXISTS artdoc (
      urlKey  TEXT NOT NULL,
      backend TEXT NOT NULL,
      docRef  TEXT NOT NULL,
      at      INTEGER NOT NULL,
      PRIMARY KEY (urlKey, backend)
    );

    -- hpath → 日报索引文档。**必须按 hpath 而不是按天**：旧的 docs 表只用 day
    -- 做主键，用户改了 docPathPrefix 之后，索引行会被写回旧路径下的文档里
    -- （实测踩过：验证时把索引写进了用户真实的 /阅读记录/2026-08-19）。
    CREATE TABLE IF NOT EXISTS idxdoc (
      hpath       TEXT PRIMARY KEY,
      docId       TEXT NOT NULL,
      tailBlockId TEXT
    );

    -- 文章全文。连续对话的首条消息就是它 —— 前缀恒定才能稳定命中 prompt cache。
    -- 由前端脚本上传（浏览器手里本来就有正文，不必让 agent 再去抓一遍），
    -- 按内容哈希判断是否变化：页面改版/懒加载补齐后 hash 变，对话自然重开。
    CREATE TABLE IF NOT EXISTS article_text (
      urlKey TEXT PRIMARY KEY,
      hash   TEXT NOT NULL,
      title  TEXT NOT NULL DEFAULT '',
      url    TEXT NOT NULL DEFAULT '',
      text   TEXT NOT NULL,
      at     INTEGER NOT NULL
    );

    -- 本地 agent 的会话 id。agent 自己维护对话历史（claude --resume /
    -- dsh --resume），所以我们只需记住"这篇文章用的是哪个会话"，
    -- 首轮把全文发进去，后续只发新问题。
    CREATE TABLE IF NOT EXISTS agent_session (
      urlKey    TEXT NOT NULL,
      agent     TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      turns     INTEGER NOT NULL DEFAULT 0,
      -- 该会话已收到过正文的前几段。分段供给时只补差量，靠它记住进度。
      loadedChunks INTEGER NOT NULL DEFAULT 0,
      at        INTEGER NOT NULL,
      PRIMARY KEY (urlKey, agent)
    );

    -- (urlKey, backend, category) → 四个分类标题块。
    -- 思源的标题是 leaf block，内容只能用 previousID 逐块串在它后面，
    -- 所以每个分类都要各自记住"上一块"，跨同步批次才能接着往后插。
    CREATE TABLE IF NOT EXISTS heads (
      urlKey      TEXT NOT NULL,
      backend     TEXT NOT NULL,
      category    TEXT NOT NULL,      -- translate | explain | comments | note
      blockId     TEXT NOT NULL,
      lastBlockId TEXT,
      PRIMARY KEY (urlKey, backend, category)
    );
  `);
  // 渲染结果的哈希。有了它才能判断"已同步的块内容变了"——
  // 总结和评论是会被反复编辑的，只按"有没有同步过"过滤会让改动永远传不出去。
  try { db.exec('ALTER TABLE synced ADD COLUMN hash TEXT'); }
  catch { /* 已存在 */ }
  // "自上次同步后被改过"的显式标记。
  //
  // 刻意不用时间戳比较（updatedAt > synced.at）：同步完紧接着编辑会落在同一
  // 毫秒里，`>` 判不出来，测试一下就露馅 —— 依赖时钟精度的正确性是假的正确性。
  // 置位在 upsert，清位在 markSynced，与时间无关。
  try {
    db.exec('ALTER TABLE events ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0');
  } catch { /* 已存在 */ }
  // 老库补列。注意上面的 CREATE TABLE 也要带这一列，否则新库反而缺 ——
  // 建表与迁移必须成对更新（这里漏过一次，报 "no such column: loadedChunks"）。
  try {
    db.exec('ALTER TABLE agent_session ADD COLUMN loadedChunks INTEGER NOT NULL DEFAULT 0');
  } catch { /* 已存在 */ }
  // 一次性回填：已有的 syncedAt 全部来自思源
  const n = db.prepare('SELECT COUNT(*) c FROM synced').get().c;
  if (n === 0) {
    const rows = db.prepare(
      'SELECT id, syncedAt, siyuanBlockId FROM events WHERE syncedAt IS NOT NULL').all();
    const ins = db.prepare(
      'INSERT OR IGNORE INTO synced (eventId,backend,ref,at) VALUES (?,?,?,?)');
    for (const r of rows) ins.run(r.id, 'siyuan', r.siyuanBlockId, r.syncedAt);
    if (rows.length) console.log(`[db] 已回填 ${rows.length} 条思源同步记录到 synced 表`);
  }
  return db;
}

const COLS = ['id', 'urlKey', 'url', 'title', 'action', 'text', 'value', 'color',
  'anchor', 'parentId', 'createdAt', 'deletedAt', 'syncedAt', 'siyuanBlockId', 'extra',
  'dirty'];

// 曾经这里有 NOT_SYNCED = ['translate']，理由是"翻译是纯机器输出，混进笔记会
// 污染喂给 Agent 的信噪比"。现在四类记录都同步，且各自归到独立标题下 ——
// 要跳过翻译的话整段跳过 `## 翻译` 即可，比在数据层一刀切更灵活。

const rowToEvent = (r) => ({
  ...r,
  anchor: r.anchor ? JSON.parse(r.anchor) : null,
  extra: r.extra ? JSON.parse(r.extra) : null,
});

/** 批量 upsert。已存在则只更新可变字段，不覆盖 syncedAt / siyuanBlockId。 */
export function upsertEvents(events) {
  const d = open();
  const stmt = d.prepare(`
    INSERT INTO events (${COLS.join(',')})
    VALUES (${COLS.map(() => '?').join(',')})
    ON CONFLICT(id) DO UPDATE SET
      value = excluded.value,
      color = excluded.color,
      anchor = excluded.anchor,
      title = excluded.title,
      extra = excluded.extra,
      deletedAt = excluded.deletedAt,
      -- 只有内容**真的**变了才置脏，否则每次开页面的例行 upsert 都会重写笔记
      dirty = CASE WHEN events.value IS NOT excluded.value
        OR events.text IS NOT excluded.text
        OR events.extra IS NOT excluded.extra
        THEN 1 ELSE events.dirty END,
      -- 内容变更后需要重新同步
      syncedAt = CASE WHEN events.value IS NOT excluded.value THEN NULL ELSE events.syncedAt END
  `);
  const n = [];
  for (const e of events) {
    if (!e?.id || !e?.action || !e?.urlKey) continue;
    stmt.run(
      e.id, e.urlKey, e.url ?? '', e.title ?? '', e.action,
      e.text ?? null, e.value ?? null, e.color ?? null,
      e.anchor ? JSON.stringify(e.anchor) : null,
      e.parentId ?? null,
      e.createdAt ?? Date.now(),
      e.deletedAt ?? null, e.syncedAt ?? null, e.siyuanBlockId ?? null,
      e.extra ? JSON.stringify(e.extra) : null,
      0,
    );
    n.push(e.id);
  }
  return n;
}

export function listByUrlKey(urlKey) {
  return open()
    .prepare('SELECT * FROM events WHERE urlKey = ? AND deletedAt IS NULL ORDER BY createdAt')
    .all(urlKey)
    .map(rowToEvent);
}

export function softDelete(id) {
  const r = open().prepare('UPDATE events SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL')
    .run(Date.now(), id);
  return r.changes > 0;
}

/**
 * 待同步的文章（**按文章，不按天**）—— 同步模型的入口查询。
 *
 * 一篇文章只要有"从未同步"或"同步后又改过"的事件就入选。不再按创建日切分：
 * 跨天读同一篇不该被拆成两份笔记，那正是改造前的问题。
 *
 * firstDay 是最早一条记录所在的天，用来决定索引写进哪个日报 ——
 * 用同步当天会让一次性补同步历史文章时全挤到今天。
 */
export function articlesToSync(backend) {
  return open().prepare(`
    SELECT e.urlKey,
           MIN(e.title) AS title,
           MIN(e.url)   AS url,
           MIN(e.createdAt) AS firstAt
    FROM events e
    WHERE e.deletedAt IS NULL
      AND EXISTS (
        SELECT 1 FROM events x
        LEFT JOIN synced s ON s.eventId = x.id AND s.backend = ?
        WHERE x.urlKey = e.urlKey AND x.deletedAt IS NULL
          AND (s.eventId IS NULL OR x.dirty = 1)
      )
    GROUP BY e.urlKey
    ORDER BY MIN(e.createdAt)`).all(backend)
    .map((r) => ({ ...r, firstDay: dayOf(r.firstAt) }));
}

/**
 * 某文章的全部事件，附带它在该后端的同步状态。
 *
 * 刻意**不**在 SQL 里过滤掉已同步的：写入端要靠 syncedRef / syncedHash 判断
 * 该插入、该原地改写、还是该跳过。哈希是渲染结果的哈希，数据层算不出来。
 */
export function eventsForArticle(urlKey, backend) {
  return open().prepare(`
    SELECT e.*, s.ref AS syncedRef, s.hash AS syncedHash, s.at AS syncedAt2
    FROM events e
    LEFT JOIN synced s ON s.eventId = e.id AND s.backend = ?
    WHERE e.urlKey = ? AND e.deletedAt IS NULL
    ORDER BY e.createdAt`).all(backend, urlKey).map(rowToEvent);
}

/** 时间戳 → 本地时区的 YYYY-MM-DD */
function dayOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- 以下两个按天查询只留给迁移脚本核对新旧口径，同步链路已不再调用 ----

export function urlKeysForDay(day) {
  const [s, e] = dayBounds(day);
  return open().prepare(`
    SELECT urlKey, MIN(title) AS title, MIN(url) AS url
    FROM events WHERE createdAt >= ? AND createdAt < ? AND deletedAt IS NULL
    GROUP BY urlKey ORDER BY MIN(createdAt)`).all(s, e);
}

export function unsyncedForDay(day, urlKey, backend) {
  const [s, e] = dayBounds(day);
  return open().prepare(`
    SELECT e.* FROM events e
    WHERE e.urlKey = ? AND e.createdAt >= ? AND e.createdAt < ?
      AND e.deletedAt IS NULL
      AND NOT EXISTS (SELECT 1 FROM synced s WHERE s.eventId = e.id AND s.backend = ?)
    ORDER BY e.createdAt`).all(urlKey, s, e, backend).map(rowToEvent);
}

export function markSynced(id, backend, ref, hash = null) {
  const d = open();
  d.prepare('INSERT OR REPLACE INTO synced (eventId,backend,ref,at,hash) VALUES (?,?,?,?,?)')
    .run(id, backend, ref ?? null, Date.now(), hash);
  d.prepare('UPDATE events SET dirty = 0 WHERE id = ?').run(id);
  // events.syncedAt / siyuanBlockId 仅为兼容保留：反映"最近一次任意后端同步"
  d.prepare('UPDATE events SET syncedAt = ?, siyuanBlockId = COALESCE(?, siyuanBlockId) WHERE id = ?')
    .run(Date.now(), backend === 'siyuan' ? ref : null, id);
}

/** 某事件在某后端里的定位符 */
export function refOfEvent(id, backend) {
  return open().prepare('SELECT ref FROM synced WHERE eventId = ? AND backend = ?')
    .get(id, backend)?.ref ?? null;
}

/** 某后端已同步的事件 id 集合（文件型后端用来跳过已写入的） */
export function syncedIdsForBackend(backend) {
  return new Set(open().prepare('SELECT eventId FROM synced WHERE backend = ?')
    .all(backend).map((r) => r.eventId));
}

export function getIdxDoc(hpath) {
  return open().prepare('SELECT docId, tailBlockId FROM idxdoc WHERE hpath = ?').get(hpath) ?? null;
}
export function putIdxDoc(hpath, docId, tailBlockId = null) {
  open().prepare('INSERT OR REPLACE INTO idxdoc (hpath, docId, tailBlockId) VALUES (?, ?, ?)')
    .run(hpath, docId, tailBlockId);
}

export function getDoc(day) {
  return open().prepare('SELECT docId, tailBlockId FROM docs WHERE day = ?').get(day) ?? null;
}
export function putDoc(day, docId, tailBlockId = null) {
  open().prepare('INSERT OR REPLACE INTO docs (day, docId, tailBlockId) VALUES (?, ?, ?)')
    .run(day, docId, tailBlockId);
}

export function getSection(day, urlKey) {
  return open().prepare('SELECT * FROM sections WHERE day = ? AND urlKey = ?').get(day, urlKey);
}
export function putSection(day, urlKey, blockId, docId, lastBlockId = null) {
  open().prepare(
    'INSERT OR REPLACE INTO sections (day,urlKey,blockId,docId,lastBlockId) VALUES (?,?,?,?,?)')
    .run(day, urlKey, blockId, docId, lastBlockId);
}

// ---- article_text：连续对话的全文前缀 ----

export function getArticleText(urlKey) {
  return open().prepare('SELECT hash, title, url, text FROM article_text WHERE urlKey = ?')
    .get(urlKey) ?? null;
}
export function putArticleText(urlKey, { hash, title, url, text }) {
  open().prepare(`INSERT OR REPLACE INTO article_text (urlKey,hash,title,url,text,at)
    VALUES (?,?,?,?,?,?)`).run(urlKey, hash, title ?? '', url ?? '', text, Date.now());
}

// ---- agent_session：agent 侧的对话续接 ----

export function getAgentSession(urlKey, agent) {
  return open().prepare(
    'SELECT sessionId, turns, loadedChunks FROM agent_session WHERE urlKey = ? AND agent = ?')
    .get(urlKey, agent) ?? null;
}
export function putAgentSession(urlKey, agent, sessionId, turns, loadedChunks = 0) {
  open().prepare(`INSERT OR REPLACE INTO agent_session
    (urlKey,agent,sessionId,turns,loadedChunks,at) VALUES (?,?,?,?,?,?)`)
    .run(urlKey, agent, sessionId, turns, loadedChunks, Date.now());
}
export function dropAgentSession(urlKey, agent) {
  open().prepare('DELETE FROM agent_session WHERE urlKey = ? AND agent = ?').run(urlKey, agent);
}

/**
 * 按内容找已有答案 —— 本地 QA 缓存。
 *
 * 复用 lookupkey 的去重口径（原文 + 问题 / 原文 + 目标语言），所以"同一段同一问题"
 * 命中的正是那条已存在的记录。不新增存储：答案本来就在 events 里。
 *
 * 意义不只是省钱：agent 一次几十秒，重复问同一句话再等一遍毫无道理。
 */
export function findLookup(urlKey, draft) {
  const key = lookupKey(draft);
  return open().prepare(`SELECT * FROM events
    WHERE urlKey = ? AND action = ? AND deletedAt IS NULL AND value IS NOT NULL`)
    .all(urlKey, draft.action).map(rowToEvent)
    .find((e) => lookupKey(e) === key) ?? null;
}

/**
 * 该文章此前的查询记录，按时间升序 —— 连续对话的历史轮次由此重建。
 *
 * @param {string|string[]} actions **同一个后端上的对话是共享的**，所以这里收一组
 *   action：走 agent 时是 ['summary','explain']，纯 LLM 时是
 *   ['summary','explain','translate']（翻译始终走 LLM，见 lookup.mjs 的 convoActions）。
 */
export function lookupHistory(urlKey, actions) {
  const list = Array.isArray(actions) ? actions : [actions];
  if (!list.length) return [];
  const holes = list.map(() => '?').join(',');
  return open().prepare(`SELECT * FROM events
    WHERE urlKey = ? AND action IN (${holes}) AND deletedAt IS NULL AND value IS NOT NULL
    ORDER BY createdAt`).all(urlKey, ...list).map(rowToEvent);
}

// ---- artdoc：文章 → 唯一目标文档 ----

export function getArtDoc(urlKey, backend) {
  // 空串是"被重置过的坏落点"（见 siyuan.mjs 的 SIYUAN_BAD_DOC），当作没有记录
  return open().prepare('SELECT docRef FROM artdoc WHERE urlKey = ? AND backend = ?')
    .get(urlKey, backend)?.docRef || null;
}
export function putArtDoc(urlKey, backend, docRef) {
  open().prepare('INSERT OR REPLACE INTO artdoc (urlKey,backend,docRef,at) VALUES (?,?,?,?)')
    .run(urlKey, backend, docRef, Date.now());
}
/** 该后端已占用的文档名集合，用于 docName 的同名冲突判定 */
export function docRefsOfBackend(backend) {
  return new Map(open().prepare('SELECT urlKey, docRef FROM artdoc WHERE backend = ?')
    .all(backend).map((r) => [r.docRef, r.urlKey]));
}

// ---- heads：文章内四个分类标题 ----

export function getHead(urlKey, backend, category) {
  return open().prepare(
    'SELECT blockId, lastBlockId FROM heads WHERE urlKey = ? AND backend = ? AND category = ?')
    .get(urlKey, backend, category) ?? null;
}
export function putHead(urlKey, backend, category, blockId, lastBlockId = null) {
  open().prepare(`INSERT OR REPLACE INTO heads
    (urlKey,backend,category,blockId,lastBlockId) VALUES (?,?,?,?,?)`)
    .run(urlKey, backend, category, blockId, lastBlockId);
}

/** 某事件此前同步到的思源块 id（用于把后补的评论插到其高亮之后） */
export function blockIdOfEvent(id) {
  return refOfEvent(id, 'siyuan');
}

/** 本地时区的一天边界，避免 UTC 切分导致晚间标注落到前一天 */
function dayBounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return [start, end];
}

export function stats(backend = 'siyuan') {
  const d = open();
  return {
    total: d.prepare('SELECT COUNT(*) c FROM events WHERE deletedAt IS NULL').get().c,
    articles: d.prepare('SELECT COUNT(DISTINCT urlKey) c FROM events WHERE deletedAt IS NULL').get().c,
    unsynced: d.prepare(`SELECT COUNT(*) c FROM events e
      LEFT JOIN synced s ON s.eventId = e.id AND s.backend = ?
      WHERE e.deletedAt IS NULL
        AND (s.eventId IS NULL OR e.dirty = 1)`)
      .get(backend).c,
    backend,
  };
}
