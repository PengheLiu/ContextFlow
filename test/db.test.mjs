// 数据层：按文章（而非按天）选取待同步内容。
//
// 这一层此前零测试覆盖，而它决定"哪些内容会被写进你的笔记"——
// 漏选就是用户看到的"同步丢东西"。
//
// 用 CONTEXTFLOW_DIR 指向临时目录，绝不碰真实库。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'cf-db-'));
process.env.CONTEXTFLOW_DIR = DIR;
const db = await import('../server/db.mjs');

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const DAY = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const ev = (o) => ({
  urlKey: 'art:1', url: 'https://x/1', title: 'T', action: 'highlight',
  text: 't', value: null, anchor: { start: 0 }, createdAt: DAY(2026, 8, 19), ...o,
});
const keys = (arr) => arr.map((a) => a.urlKey).sort().join(',');
const evIds = (arr) => arr.map((e) => e.id).sort().join(',');

console.log('数据层：按文章选取待同步\n');

// ---- 核心：不再按天切分 ----

t('同一篇跨天的记录一起入选（改造前的核心缺陷）', () => {
  db.upsertEvents([
    ev({ id: 'h-19', createdAt: DAY(2026, 8, 19) }),
    ev({ id: 'e-20', action: 'explain', value: 'a', createdAt: DAY(2026, 8, 20) }),
  ]);
  const arts = db.articlesToSync('siyuan');
  assert.equal(keys(arts), 'art:1');
  assert.equal(evIds(db.eventsForArticle('art:1', 'siyuan')), 'e-20,h-19');
});

t('firstDay 取最早一条所在的天，不是同步当天', () =>
  assert.equal(db.articlesToSync('siyuan')[0].firstDay, '2026-08-19'));

t('翻译已纳入同步（NOT_SYNCED 已退役）', () => {
  db.upsertEvents([ev({ id: 'tr-1', action: 'translate', value: '威胁模型' })]);
  const all = db.eventsForArticle('art:1', 'siyuan');
  assert.ok(all.some((e) => e.action === 'translate'), '翻译被排除了');
});

// ---- 同步状态 ----

t('已同步的事件带回 syncedRef / syncedHash', () => {
  db.markSynced('h-19', 'siyuan', 'block-abc', 'hash1');
  const e = db.eventsForArticle('art:1', 'siyuan').find((x) => x.id === 'h-19');
  assert.equal(e.syncedRef, 'block-abc');
  assert.equal(e.syncedHash, 'hash1');
});

t('eventsForArticle 不过滤已同步的（写入端要靠它判断插入还是改写）', () => {
  const all = db.eventsForArticle('art:1', 'siyuan');
  assert.ok(all.some((e) => e.id === 'h-19'), '已同步的被过滤掉了');
});

t('同步状态按后端隔离：思源已同步 ≠ obsidian 已同步', () => {
  const e = db.eventsForArticle('art:1', 'obsidian').find((x) => x.id === 'h-19');
  assert.equal(e.syncedRef, null);
});

t('全部同步完后该文章不再入选', () => {
  for (const e of db.eventsForArticle('art:1', 'siyuan')) {
    db.markSynced(e.id, 'siyuan', `b-${e.id}`, 'h');
  }
  assert.equal(db.articlesToSync('siyuan').length, 0);
});

// ---- 改动回写：总结/评论是会被反复编辑的 ----

t('改了内容后重新入选（否则总结同步一次就冻住）', () => {
  db.upsertEvents([ev({ id: 'note-1', action: 'note', value: '初稿', anchor: null })]);
  db.markSynced('note-1', 'siyuan', 'blk-note', 'h-初稿');
  assert.equal(db.articlesToSync('siyuan').length, 0, '刚同步完不该入选');

  db.upsertEvents([ev({ id: 'note-1', action: 'note', value: '改过的总结', anchor: null })]);
  assert.equal(db.articlesToSync('siyuan').length, 1, '改了内容却没重新入选');
});

t('无变化的 upsert 不会让它重新入选（避免每次开页面都重写笔记）', () => {
  for (const e of db.eventsForArticle('art:1', 'siyuan')) {
    db.markSynced(e.id, 'siyuan', `b-${e.id}`, 'h');
  }
  const same = db.eventsForArticle('art:1', 'siyuan').find((x) => x.id === 'note-1');
  db.upsertEvents([{ ...same, anchor: null }]);
  assert.equal(db.articlesToSync('siyuan').length, 0);
});

t('软删除的事件不入选、也不返回', () => {
  db.upsertEvents([ev({ id: 'del-1', action: 'explain', value: 'x' })]);
  db.softDelete('del-1');
  assert.ok(!db.eventsForArticle('art:1', 'siyuan').some((e) => e.id === 'del-1'));
});

// ---- artdoc：一文一档的落点 ----

t('artdoc 记住后取回同一个 docRef', () => {
  assert.equal(db.getArtDoc('art:1', 'siyuan'), null);
  db.putArtDoc('art:1', 'siyuan', 'doc-20260819');
  assert.equal(db.getArtDoc('art:1', 'siyuan'), 'doc-20260819');
});

t('artdoc 按后端隔离（同一篇在思源是 docId、在 obsidian 是文件名）', () => {
  db.putArtDoc('art:1', 'obsidian', 'Threat Model.md');
  assert.equal(db.getArtDoc('art:1', 'siyuan'), 'doc-20260819');
  assert.equal(db.getArtDoc('art:1', 'obsidian'), 'Threat Model.md');
});

t('重复 put 覆盖而不是插两行', () => {
  db.putArtDoc('art:1', 'siyuan', 'doc-new');
  assert.equal(db.getArtDoc('art:1', 'siyuan'), 'doc-new');
});

t('docRefsOfBackend 给出 名字 → urlKey，用于同名冲突判定', () => {
  const m = db.docRefsOfBackend('obsidian');
  assert.equal(m.get('Threat Model.md'), 'art:1');
});

// ---- heads：四个分类标题各自的游标 ----

t('heads 按 (文章, 后端, 分类) 三元组独立存取', () => {
  db.putHead('art:1', 'siyuan', 'translate', 'h-tr', 'last-tr');
  db.putHead('art:1', 'siyuan', 'comments', 'h-cm', null);
  // node:sqlite 返回 null-prototype 对象，展开一层再比
  assert.deepEqual({ ...db.getHead('art:1', 'siyuan', 'translate') },
    { blockId: 'h-tr', lastBlockId: 'last-tr' });
  assert.equal(db.getHead('art:1', 'siyuan', 'comments').lastBlockId, null);
  assert.equal(db.getHead('art:1', 'siyuan', 'note'), null);
});

t('游标可推进（跨批次接着往后插的前提）', () => {
  db.putHead('art:1', 'siyuan', 'comments', 'h-cm', 'blk-9');
  assert.equal(db.getHead('art:1', 'siyuan', 'comments').lastBlockId, 'blk-9');
});

// ---- article_text / agent_session：连续对话与分段供给的状态 ----
//
// 这一组的由来：loadedChunks 那列漏加时，报错是运行时的
// "no such column: loadedChunks"，而当时整套测试全绿 —— 因为压根没有用例
// 碰过 agent_session。建表与迁移必须成对更新，这里就是那道闸。

t('全文按 urlKey 存取，带哈希与标题', () => {
  db.putArticleText('art:1', { hash: 'h1', title: 'T', url: 'u', text: '正文内容' });
  const r = db.getArticleText('art:1');
  assert.equal(r.hash, 'h1');
  assert.equal(r.text, '正文内容');
  assert.equal(r.title, 'T');
});

t('全文重存覆盖而不是插两行', () => {
  db.putArticleText('art:1', { hash: 'h2', title: 'T2', url: 'u', text: '新正文' });
  assert.equal(db.getArticleText('art:1').hash, 'h2');
  assert.equal(db.getArticleText('art:1').text, '新正文');
});

t('没存过的文章返回 null', () => assert.equal(db.getArticleText('art:没有'), null));

t('agent 会话记住 sessionId / 轮数 / 已加载段数', () => {
  db.putAgentSession('art:1', 'claude', 'sid-1', 2, 3);
  const s2 = db.getAgentSession('art:1', 'claude');
  assert.equal(s2.sessionId, 'sid-1');
  assert.equal(s2.turns, 2);
  assert.equal(s2.loadedChunks, 3, '分段进度没存住 —— 会导致每次都重发正文');
});

t('loadedChunks 省略时默认 0（首轮从第一段开始发）', () => {
  db.putAgentSession('art:2', 'codex', 'sid-2', 1);
  assert.equal(db.getAgentSession('art:2', 'codex').loadedChunks, 0);
});

t('段数可推进', () => {
  db.putAgentSession('art:1', 'claude', 'sid-1', 3, 5);
  assert.equal(db.getAgentSession('art:1', 'claude').loadedChunks, 5);
});

t('会话按 agent 隔离', () => {
  assert.equal(db.getAgentSession('art:1', 'codex'), null);
  assert.equal(db.getAgentSession('art:1', 'claude').sessionId, 'sid-1');
});

t('丢弃会话后取回 null（正文变了要重开对话）', () => {
  db.dropAgentSession('art:1', 'claude');
  assert.equal(db.getAgentSession('art:1', 'claude'), null);
});

t('lookupHistory 按时间升序，且跳过没有结果的', () => {
  db.upsertEvents([
    ev({ id: 'h-b', action: 'translate', text: 'B', value: '乙', createdAt: DAY(2026, 8, 20) }),
    ev({ id: 'h-a', action: 'translate', text: 'A', value: '甲', createdAt: DAY(2026, 8, 19) }),
    ev({ id: 'h-x', action: 'translate', text: 'X', value: null, createdAt: DAY(2026, 8, 21) }),
  ]);
  const ids = db.lookupHistory('art:1', 'translate').map((e) => e.id);
  assert.ok(!ids.includes('h-x'), '半成品进了历史');
  const ia = ids.indexOf('h-a'), ib = ids.indexOf('h-b');
  assert.ok(ia >= 0 && ib >= 0 && ia < ib, `顺序不对：${ids}`);
});

// ---- stats ----

t('stats.unsynced 计入"改过的"，不只是"从未同步的"', () => {
  db.upsertEvents([ev({ id: 'note-1', action: 'note', value: '又改了', anchor: null })]);
  assert.ok(db.stats('siyuan').unsynced > 0);
});

// ---- findLookup：本地 QA 缓存 ----
//
// 意义不只是省钱：agent 一次几十秒，重复问同一句话再等一遍毫无道理。

t('同一段 + 同一问题 → 命中已有答案', () => {
  db.upsertEvents([ev({
    id: 'q1', urlKey: 'qa:1', action: 'explain', text: 'Threat model',
    value: '这一节定义攻击者能力', extra: { question: '这段在讲什么' },
  })]);
  const hit = db.findLookup('qa:1', {
    action: 'explain', text: 'Threat model', extra: { question: '这段在讲什么' },
  });
  assert.equal(hit?.value, '这一节定义攻击者能力');
});

t('首尾标点差异也算同一段（与去重口径一致）', () => {
  const hit = db.findLookup('qa:1', {
    action: 'explain', text: 'Threat model.', extra: { question: '这段在讲什么' },
  });
  assert.ok(hit, '标点差异导致没命中 —— 和去重口径不一致了');
});

t('同一段但换了问题 → 不命中（那是另一个问题）', () =>
  assert.equal(db.findLookup('qa:1', {
    action: 'explain', text: 'Threat model', extra: { question: '怎么防' },
  }), null));

t('翻译按目标语言区分', () => {
  db.upsertEvents([ev({
    id: 'q2', urlKey: 'qa:1', action: 'translate', text: 'Threat model',
    value: '威胁模型', extra: { target: '简体中文' },
  })]);
  assert.ok(db.findLookup('qa:1', { action: 'translate', text: 'Threat model', extra: { target: '简体中文' } }));
  assert.equal(db.findLookup('qa:1', { action: 'translate', text: 'Threat model', extra: { target: 'English' } }), null);
});

t('跨文章不串味', () =>
  assert.equal(db.findLookup('qa:2', {
    action: 'explain', text: 'Threat model', extra: { question: '这段在讲什么' },
  }), null));

t('没有结果的记录不算命中（半成品不能当缓存）', () => {
  db.upsertEvents([ev({ id: 'q3', urlKey: 'qa:3', action: 'explain', text: 'X', value: null, extra: { question: 'q' } })]);
  assert.equal(db.findLookup('qa:3', { action: 'explain', text: 'X', extra: { question: 'q' } }), null);
});

t('软删除后不再命中', () => {
  db.softDelete('q1');
  assert.equal(db.findLookup('qa:1', {
    action: 'explain', text: 'Threat model', extra: { question: '这段在讲什么' },
  }), null);
});

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} 项通过`);
