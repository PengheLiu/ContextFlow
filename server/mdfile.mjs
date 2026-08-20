// 文件型同步后端：**一篇文章一个 Markdown 文件**，日报只留索引。
//
// 一份代码服务两个后端：
//   obsidian —— 目标目录在 vault 里（Obsidian 监听文件系统，自动收录）
//   markdown —— 目标目录任意（降级方案，不依赖任何笔记软件）
//
// 为什么不用 Obsidian 的 Local REST API：
//   那个插件能让索引即时更新、支持按标题 PATCH，确实更"贴合"，
//   但它要求用户装插件 + 处理自签 TLS + 管 API key。而 vault 本身就是一个
//   装 .md 的普通文件夹，直接写文件对**所有** Obsidian 用户都有效，
//   并且同一份实现顺手就是"保存 markdown 到本地"的降级方案。
//   取舍：拿不到块级 id，所以幂等靠文件里的标记注释（见下）。
//
// 为什么从"按天汇总"改成"一文一档"：
//   按天分文件时，跨天读同一篇文章会被切成两半 —— 实测里 21 条高亮在
//   2026-08-19.md、6 条解释在 2026-08-20.md，看起来就像同步丢了东西。
//   现在文章的落点由 db 的 artdoc 表钉死：首次同步记下文件名，此后永远追加
//   到同一个文件，绝不新建第二个。
//
// 幂等设计（三道）：
//   1. artdoc 表记住文章 → 文件，不会重复建文件
//   2. 每块前面独占一行的 `<!-- cf:<eventId> -->` 标记 —— 即使 DB 丢了，
//      扫一遍标记也能知道哪些已经写过，不会重复追加。放在块前而非块尾，
//      是因为块内容可能含空行（多段总结），标记在尾部就界定不出块的起点
//   3. 分类标题带 `<!-- cf:cat <key> -->`、文章头带 `<!-- cf:art <urlKey> -->`，
//      因此用户改标题文字也不会导致重复建节
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as db from './db.mjs';
import { CATEGORIES, LABEL_OF, groupByCategory, docName, contentHash } from './layout.mjs';

const err = (msg, code) => Object.assign(new Error(msg), { code });

const EV_MARK = (id) => `<!-- cf:${id} -->`;
const ART_MARK = (urlKey) => `<!-- cf:art ${urlKey} -->`;
const CAT_MARK = (key) => `<!-- cf:cat ${key} -->`;
const IDX_MARK = (urlKey) => `<!-- cf:idx ${urlKey} -->`;

const ART_RE = /^<!-- cf:art (.+) -->$/;
const CAT_RE = /^<!-- cf:cat ([a-z]+) -->$/;
const IDX_RE = /^<!-- cf:idx (.+) -->$/;
const EV_RE = /<!-- cf:([A-Za-z0-9_:.-]+) -->\s*$/;

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const mdEscape = (s) => String(s ?? '').replace(/[[\]]/g, '\\$&');
/** 原文引用可能跨段，逐行加 `> ` 才不会破坏引用块 */
const quote = (s) => oneLine(s).split('\n').map((l) => `> ${l}`).join('\n');

/** 本地时区 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚间标注会落到前一天） */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 事件 → Markdown 块。
 * 翻译与解释都带上原文引用 —— 脱离网页后，只看译文/答案根本不知道在说哪一段。
 */
export function render(ev) {
  const v = String(ev.value ?? '').trim();
  switch (ev.action) {
    case 'highlight': return quote(ev.text);
    case 'comment': return v ? `💬 ${v}` : '';
    case 'note': return v || '';
    case 'translate': return v ? `${quote(ev.text)}\n${v}` : '';
    case 'explain': {
      if (!v) return '';
      const q = oneLine(ev.extra?.question) || '这段在讲什么';
      return `**❓ ${q}**\n${quote(ev.text)}\n${v}`;
    }
    default: return '';
  }
}

/**
 * 把文件内容按标记解析成结构。
 *
 * 事件标记独占一行、放在块**之前**。这不是随手定的：块内容本身可能含空行
 * （多段总结就是典型），所以"向上找到空行为止"界定不出块范围 —— 原地替换
 * 会只换掉最后一段，把前面的段落变成孤儿。
 * 现在块范围 = 标记行 → 下一个边界（另一个标记 / 标题 / 文件尾）。
 *
 * 同时兼容旧格式的行尾标记：那时的块都是单行，把标记行本身当作块即可。
 *
 * @returns {{events: Map<string,{from,to}>, cats: Map<string,{markerAt,endAt}>}}
 */
function parse(lines) {
  const isHeading = (t) => /^#{1,6}\s/.test(t);
  const marks = [];              // { at, id }  事件标记行
  const cats = new Map();
  const bounds = [];             // 所有可作为块终止的行号

  lines.forEach((line, i) => {
    const t = line.trim();
    if (ART_RE.test(t) || CAT_RE.test(t) || IDX_RE.test(t) || isHeading(t)) bounds.push(i);
    const c = t.match(CAT_RE);
    if (c) cats.set(c[1], { markerAt: i, endAt: lines.length - 1 });
    const m = t.match(EV_RE);
    if (m && !ART_RE.test(t) && !CAT_RE.test(t) && !IDX_RE.test(t)) {
      marks.push({ at: i, id: m[1] });
      bounds.push(i);
    }
  });
  bounds.sort((a, b) => a - b);

  // 分类区间：止于下一个分类标题之前
  const catList = [...cats.entries()].sort((a, b) => a[1].markerAt - b[1].markerAt);
  catList.forEach(([, v], idx) => {
    const next = catList[idx + 1];
    if (next) v.endAt = next[1].markerAt - 2;   // -2：连它上面的 `## 标题` 一起让位
  });

  const events = new Map();
  for (const { at, id } of marks) {
    const next = bounds.find((b) => b > at) ?? lines.length;
    let to = next - 1;
    while (to > at && lines[to].trim() === '') to--;      // 不吞掉块之间的空行
    events.set(id, { from: at, to });
  }
  return { events, cats };
}

function newFile(art) {
  const title = oneLine(art.title) || art.urlKey;
  return [
    '---',
    ...(art.url ? [`url: ${art.url}`] : []),
    `first_read: ${art.firstDay}`,
    'tags: [reading, contextflow]',
    '---',
    '',
    `# ${mdEscape(title)}`,
    ART_MARK(art.urlKey),
    '',
  ];
}

/** 把某分类的块插到正确位置：已有该标题就追加到节末，否则按 CATEGORIES 顺序建节 */
function place(lines, catKey, blocks) {
  let { cats } = parse(lines);
  const sec = cats.get(catKey);
  if (sec) {
    let at = sec.endAt;
    while (at > sec.markerAt && lines[at].trim() === '') at--;      // 跳过尾部空行
    lines.splice(at + 1, 0, '', ...blocks);
    return;
  }

  // 新建分类标题。插在**后一个已存在分类之前**，让四节顺序恒定 ——
  // 一律追加到文件尾会让节序取决于同步先后，同一篇文章在两台机器上长得不一样。
  const order = CATEGORIES.map((c) => c.key);
  const mine = order.indexOf(catKey);
  let insertAt = lines.length;
  for (const c of order.slice(mine + 1)) {
    const later = cats.get(c);
    if (later) { insertAt = later.markerAt - 1; break; }            // -1：连标题行一起让位
  }
  const head = ['', `## ${LABEL_OF.get(catKey)}`, CAT_MARK(catKey), '', ...blocks];
  lines.splice(Math.max(0, insertAt), 0, ...head);
}

/**
 * 标记独占一行、置于块前（理由见 parse 的注释：块内容可能含空行）。
 * HTML 注释在渲染视图里不可见，不影响阅读。
 */
function stamp(md, id) {
  return [EV_MARK(id), ...md.split('\n')];
}

function resolveDir(backend, root, folder) {
  if (!root) {
    throw err(backend === 'obsidian'
      ? '未配置 Obsidian vault 路径（在面板「配置」里填）'
      : '未配置 Markdown 导出目录（在面板「配置」里填）', 'NO_TARGET');
  }
  const dir = resolve(root, (folder || '').replace(/^[/\\]+/, ''));
  // 防越界：folder 里若写了 ../ 就会跑到 vault 外面
  if (!resolve(dir).startsWith(resolve(root))) {
    throw err(`目标目录越出根目录：${folder}`, 'BAD_TARGET');
  }
  return dir;
}

/**
 * 同步全部待同步文章，每篇写入自己的文件。
 * @returns {{files, articles, inserted, updated, details}}
 */
export async function syncAll({ backend, root, folder }, opts = {}) {
  const dir = resolveDir(backend, root, folder);
  const articles = opts.urlKey
    ? db.articlesToSync(backend).filter((a) => a.urlKey === opts.urlKey)
    : db.articlesToSync(backend);

  let inserted = 0, updated = 0;
  const details = [];
  const files = [];

  for (const art of articles) {
    const r = syncArticle({ backend, dir, art });
    inserted += r.inserted; updated += r.updated;
    if (r.inserted || r.updated) files.push(r.name);
    details.push({ urlKey: art.urlKey, title: art.title, ...r });
  }
  return { articles: articles.length, inserted, updated, files, details };
}

function syncArticle({ backend, dir, art }) {
  // 落点：artdoc 里有就用那个，绝不新建第二个文件
  let name = db.getArtDoc(art.urlKey, backend);
  if (!name) {
    const taken = db.docRefsOfBackend(backend);
    name = `${docName(art.title, art.urlKey,
      (n) => taken.has(`${n}.md`) && taken.get(`${n}.md`) !== art.urlKey)}.md`;
  }
  const file = join(dir, name);

  let lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : newFile(art);
  const seen = parse(lines);

  const events = db.eventsForArticle(art.urlKey, backend);
  let inserted = 0, updated = 0;

  for (const [catKey, group] of groupByCategory(events)) {
    const fresh = [];
    for (const ev of group) {
      const md = render(ev);
      if (!md) continue;
      const hash = contentHash(md);
      const where = seen.events.get(ev.id);

      if (where) {
        // 已在文件里。内容没变就跳过，变了就**原地替换**——
        // 总结和评论是会被反复编辑的，追加一份新的等于笔记里出现两个版本
        if (ev.syncedHash === hash) continue;
        lines.splice(where.from, where.to - where.from + 1, ...stamp(md, ev.id));
        db.markSynced(ev.id, backend, `${name}#${ev.id}`, hash);
        updated++;
        Object.assign(seen, parse(lines));      // 行号已变
        continue;
      }
      fresh.push(...stamp(md, ev.id), '');
      db.markSynced(ev.id, backend, `${name}#${ev.id}`, hash);
      inserted++;
    }
    if (fresh.length) {
      place(lines, catKey, fresh);
      Object.assign(seen, parse(lines));
    }
  }

  if (!inserted && !updated) return { name, inserted: 0, updated: 0 };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  db.putArtDoc(art.urlKey, backend, name);
  writeIndex({ backend, dir, art, name });
  return { name, inserted, updated };
}

/**
 * 日报索引：往「文章最早一条记录所在那天」的日报里追加一行链接。
 * 用最早那天而不是同步当天 —— 一次性补同步历史文章时才不会全挤到今天。
 */
function writeIndex({ backend, dir, art, name }) {
  const file = join(dir, `${art.firstDay}.md`);
  let lines = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n')
    : ['---', `date: ${art.firstDay}`, 'tags: [reading, contextflow]', '---', '',
      `# ${art.firstDay} 阅读记录`, ''];

  const mark = IDX_MARK(art.urlKey);
  if (lines.some((l) => l.includes(mark))) return;      // 已索引过

  const title = oneLine(art.title) || art.urlKey;
  const base = name.replace(/\.md$/, '');
  // wikilink 只有 Obsidian 认；纯 markdown 后端用相对链接才点得开
  const link = backend === 'obsidian'
    ? `[[${base}]]`
    : `[${mdEscape(title)}](${encodeURI(name)})`;
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push(`- ${link} ${mark}`);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}
