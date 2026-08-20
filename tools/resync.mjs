// 一次性维护：把旧模型（按天汇总）产生的内容，按新模型（一文一档）重写一份。
//
// 为什么需要：同步是**只插不改**的，已标记同步的事件不会再处理。所以改成
// 一文一档之后，历史内容仍然散在旧的日报文件/文档里。这个脚本清掉指定后端的
// synced 标记，让下一次同步把它们完整重写到该文章的统一文档里。
//
// **不会删除旧位置的内容。** 那些块下面可能有你自己手写的东西，删了不可逆。
// 脚本会明确列出哪些旧位置将变成重复，由你手工清理一次。
//
//   node tools/resync.mjs --backend siyuan            只报告
//   node tools/resync.mjs --backend siyuan --apply    清标记（下次同步即重写）
//   node tools/resync.mjs --backend obsidian --urlkey arxiv:2608.09867 --apply
// 走 db.mjs 的 open() 而不是裸 DatabaseSync：建表与迁移都在那里，
// 自己开库会碰不到 artdoc / heads 这些新表。
import { open } from '../server/db.mjs';

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : def;
};
const APPLY = process.argv.includes('--apply');
const BACKEND = arg('backend');
const URLKEY = arg('urlkey');
const BACKENDS = ['siyuan', 'obsidian', 'markdown'];

if (!BACKENDS.includes(BACKEND)) {
  console.error(`用法: node tools/resync.mjs --backend <${BACKENDS.join('|')}> [--urlkey <k>] [--apply]`);
  process.exit(1);
}

const db = open();

const where = URLKEY ? 'AND e.urlKey = ?' : '';
const params = URLKEY ? [BACKEND, URLKEY] : [BACKEND];

const rows = db.prepare(`
  SELECT e.id, e.urlKey, e.action, e.title, s.ref
  FROM events e JOIN synced s ON s.eventId = e.id AND s.backend = ?
  WHERE e.deletedAt IS NULL ${where}
  ORDER BY e.urlKey, e.createdAt`).all(...params);

if (!rows.length) {
  console.log(`${BACKEND}：没有已同步的记录，无需重写。`);
  process.exit(0);
}

// 按文章汇总
const byArt = new Map();
for (const r of rows) {
  if (!byArt.has(r.urlKey)) byArt.set(r.urlKey, { title: r.title, rows: [], refs: new Set() });
  const a = byArt.get(r.urlKey);
  a.rows.push(r);
  // 旧位置：文件型后端的 ref 形如 `2026-08-19.md#<id>`，取文件名；思源是块 id
  a.refs.add(BACKEND === 'siyuan' ? '（思源旧块）' : String(r.ref || '').split('#')[0]);
}

const counts = (rs) => {
  const c = {};
  for (const r of rs) c[r.action] = (c[r.action] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' · ');
};

console.log(`后端 ${BACKEND}：${byArt.size} 篇文章、${rows.length} 条已同步记录将被重写\n`);
for (const [urlKey, a] of byArt) {
  console.log(`  ${a.title || urlKey}`);
  console.log(`    ${urlKey}`);
  console.log(`    ${a.rows.length} 条：${counts(a.rows)}`);
  console.log(`    旧位置（将变成重复，需你手工清理）：${[...a.refs].join(', ')}`);
}

// 未同步的部分也顺带报一下，好和面板上的数字对账
const pending = db.prepare(`
  SELECT COUNT(*) c FROM events e
  LEFT JOIN synced s ON s.eventId = e.id AND s.backend = ?
  WHERE e.deletedAt IS NULL AND s.eventId IS NULL ${where}`).get(...params).c;
if (pending) console.log(`\n另有 ${pending} 条从未同步过，本来就会在下次同步时写入。`);

if (!APPLY) {
  console.log('\n以上仅为统计。加 --apply 清除同步标记，下次点「同步到笔记」即完整重写。');
  process.exit(0);
}

// 清标记：synced 行、artdoc 落点、heads 游标都要清 ——
// 只清 synced 会让内容重新插进**旧文档**里，等于白做。
const tx = db.prepare('DELETE FROM synced WHERE eventId = ? AND backend = ?');
let n = 0;
for (const r of rows) { tx.run(r.id, BACKEND); n++; }

const arts = [...byArt.keys()];
const delArt = db.prepare('DELETE FROM artdoc WHERE urlKey = ? AND backend = ?');
const delHead = db.prepare('DELETE FROM heads WHERE urlKey = ? AND backend = ?');
for (const k of arts) { delArt.run(k, BACKEND); delHead.run(k, BACKEND); }

console.log(`\n已清除 ${n} 条同步标记、${arts.length} 篇文章的落点与标题游标。`);
console.log('下一次「同步到笔记」会把它们完整写入各自的新文档。');
console.log('旧位置的内容仍在原处，确认新文档无误后再手工删除。');
