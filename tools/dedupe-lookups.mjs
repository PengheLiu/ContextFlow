// 一次性维护：合并历史上重复的查询记录（翻译 / 解释）。
//
// 去重是后来才加的（用内容派生稳定 id + upsert），此前每次查询都新建一条，
// 所以旧数据里同一段会有多条。这个脚本按与运行时**同一套口径**归并：
//   translate —— urlKey + 原文 + 目标语言
//   explain   —— urlKey + 原文 + 你提的问题
// 每组保留最早那条（列表记的是"你查过什么"，不是最后一次查的时间），
// 其余连同 synced 表里的引用一并删除。
//
// 顺带回填一个升级遗留：去重键加进来之前，translate 记录没存 target，
// 键尾是空的；新记录带 target，两者不相等 —— 同一段再翻一次仍会多一条。
// 按配置里的默认目标语言补上（历史记录本来就是用那个默认值翻的）。
//
// 刻意不放进服务启动流程：启动时静默删用户数据是危险的默认行为。
//   node tools/dedupe-lookups.mjs         只统计
//   node tools/dedupe-lookups.mjs --apply 执行删除 + 回填
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
// 直接复用运行时那份去重键 —— 脚本再实现一份 norm 必然与运行时走形，
// 上一版就因此漏掉了"首尾标点差异"这一类重复。
import { lookupKey } from '../src/core/lookupkey.js';
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const HOME = join(homedir(), '.contextflow');
const db = new DatabaseSync(join(HOME, 'context.db'));

const defaultTarget = (() => {
  try { return JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).translate?.target || ''; }
  catch { return ''; }
})();

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (r) => `${r.urlKey}|${lookupKey({
  action: r.action, text: r.text, extra: r.extra ? JSON.parse(r.extra) : null,
})}`;

const rows = db.prepare(`SELECT id, urlKey, action, text, extra, createdAt
  FROM events WHERE action IN ('translate','explain') AND deletedAt IS NULL
  ORDER BY createdAt`).all();

const groups = new Map();
for (const r of rows) {
  const k = keyOf(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
const doomed = dupes.flatMap(([, v]) => v.slice(1));   // 保留最早的那条

console.log(`查询记录 ${rows.length} 条，归并为 ${groups.size} 组`);
console.log(`其中 ${dupes.length} 组有重复，可删除 ${doomed.length} 条\n`);

for (const [, v] of dupes) {
  const r = v[0];
  const extra = r.extra ? JSON.parse(r.extra) : null;
  const tail = r.action === 'explain' ? extra?.question : extra?.target;
  console.log(`  ${r.action.padEnd(9)} ×${v.length}  ${JSON.stringify(norm(r.text).slice(0, 46))}`
    + (tail ? `  [${norm(tail).slice(0, 24)}]` : ''));
}

// 回填缺失的 target。与去重独立：即使没有重复也要补，否则同一段下次再翻仍会新增一条。
function backfillTargets() {
  if (!defaultTarget) return;
  const stale = db.prepare(`SELECT id, extra FROM events
    WHERE action='translate' AND deletedAt IS NULL`).all()
    .filter((r) => { try { return !JSON.parse(r.extra || 'null')?.target; } catch { return true; } });
  if (!stale.length) return;
  if (!APPLY) { console.log(`\n另有 ${stale.length} 条 translate 缺 target，--apply 时回填为 ${defaultTarget}`); return; }
  const upd = db.prepare('UPDATE events SET extra = ? WHERE id = ?');
  for (const r of stale) {
    let e = {}; try { e = JSON.parse(r.extra || '{}') || {}; } catch { /* 脏数据直接重建 */ }
    upd.run(JSON.stringify({ ...e, target: defaultTarget }), r.id);
  }
  console.log(`已回填 ${stale.length} 条记录的 target=${defaultTarget}`);
}

if (!doomed.length) { backfillTargets(); process.exit(0); }

if (!APPLY) {
  console.log('\n以上仅为统计。加 --apply 执行删除。');
  backfillTargets();
  process.exit(0);
}

const delEv = db.prepare('DELETE FROM events WHERE id = ?');
const delSync = db.prepare('DELETE FROM synced WHERE eventId = ?');
let n = 0;
for (const r of doomed) { delEv.run(r.id); delSync.run(r.id); n++; }
console.log(`\n已删除 ${n} 条重复记录`);
backfillTargets();

console.log(`剩余查询记录 ${db.prepare(
  "SELECT COUNT(*) c FROM events WHERE action IN ('translate','explain') AND deletedAt IS NULL"
).get().c} 条`);
