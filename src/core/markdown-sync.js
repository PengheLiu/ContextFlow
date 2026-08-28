import { CATEGORIES, groupByCategory, renderEventMarkdown, safeMarkdownFilename } from './markdown.js';
import { hashKey } from './lookupkey.js';

const artMark = (key) => `<!-- cf:art ${key} -->`;
const catMark = (key) => `<!-- cf:cat ${key} -->`;
const eventMark = (id) => `<!-- cf:${id} -->`;
const idxMark = (key) => `<!-- cf:idx ${key} -->`;
const labels = new Map(CATEGORIES.map((c) => [c.key, c.label]));

const escapeYaml = (s) => JSON.stringify(String(s || ''));
export function newArticleDocument({ title, url, urlKey, firstDay }) {
  return ['---', `url: ${escapeYaml(url)}`, `first_read: ${firstDay}`, 'tags: [reading, contextflow]', '---', '',
    `# ${String(title || urlKey).replace(/\s+/g, ' ').trim()}`, artMark(urlKey), ''].join('\n');
}

function parse(text) {
  const lines = String(text || '').split('\n'), events = new Map(), cats = new Map();
  const boundaries = [];
  lines.forEach((line, i) => {
    const t = line.trim(), cat = t.match(/^<!-- cf:cat ([a-z]+) -->$/), ev = t.match(/^<!-- cf:([A-Za-z0-9_:.-]+) -->$/);
    if (/^#{1,6}\s/.test(t) || /^<!-- cf:(?:art|cat) /.test(t)) boundaries.push(i);
    if (cat) cats.set(cat[1], { markerAt: i, endAt: lines.length - 1 });
    if (ev && !/^<!-- cf:(?:art|cat|idx) /.test(t)) { boundaries.push(i); events.set(ev[1], { from: i, to: lines.length - 1 }); }
  });
  const marks = [...events.entries()].sort((a, b) => a[1].from - b[1].from);
  for (let i = 0; i < marks.length; i++) {
    const [, v] = marks[i], next = boundaries.filter((x) => x > v.from).sort((a, b) => a - b)[0] ?? lines.length;
    v.to = next - 1; while (v.to > v.from && !lines[v.to].trim()) v.to--;
  }
  const sections = [...cats.entries()].sort((a, b) => a[1].markerAt - b[1].markerAt);
  sections.forEach(([, v], i) => { if (sections[i + 1]) v.endAt = sections[i + 1][1].markerAt - 2; });
  return { lines, events, cats };
}

function place(lines, key, block) {
  const p = parse(lines.join('\n')), sec = p.cats.get(key);
  if (sec) { let at = sec.endAt; while (at > sec.markerAt && !lines[at].trim()) at--; lines.splice(at + 1, 0, '', ...block); return; }
  const order = CATEGORIES.map((c) => c.key), mine = order.indexOf(key); let at = lines.length;
  for (const later of order.slice(mine + 1)) { const hit = p.cats.get(later); if (hit) { at = hit.markerAt - 1; break; } }
  lines.splice(Math.max(0, at), 0, '', `## ${labels.get(key)}`, catMark(key), '', ...block);
}

export function mergeArticleDocument(text, article, events, previous = new Map()) {
  let current = text || newArticleDocument(article), parsed = parse(current), lines = parsed.lines;
  let inserted = 0, updated = 0, deleted = 0, preserved = 0, conflicts = 0;
  const states = [], live = new Map(events.filter((e) => !e.deletedAt).map((e) => [e.id, e]));
  const tombstones = new Set(events.filter((e) => e.deletedAt).map((e) => e.id));
  // 只有显式 tombstone 才删除外部笔记；普通缺失不能推断为删除。
  for (const [id, old] of previous) {
    if (!tombstones.has(id)) { states.push(old); continue; }
    const where = parsed.events.get(id); if (!where) continue;
    const existing = lines.slice(where.from + 1, where.to + 1).join('\n').trim();
    if (old.hash && hashKey(existing) !== old.hash) {
      lines.splice(where.from, 1); preserved++; conflicts++;
    } else { lines.splice(where.from, where.to - where.from + 1); deleted++; }
    parsed = parse(lines.join('\n'));
  }
  for (const [cat, group] of groupByCategory(events)) {
    for (const ev of group) {
      const md = renderEventMarkdown(ev); if (!md) continue;
      const hash = hashKey(md), where = parsed.events.get(ev.id), old = previous.get(ev.id);
      if (where) {
        const existing = lines.slice(where.from + 1, where.to + 1).join('\n').trim();
        if (old?.hash === hash && hashKey(existing) === hash) { states.push({ eventId: ev.id, hash }); continue; }
        if (old?.hash && hashKey(existing) !== old.hash) { conflicts++; states.push(old); continue; }
        lines.splice(where.from, where.to - where.from + 1, eventMark(ev.id), ...md.split('\n')); updated++;
      } else { place(lines, cat, [eventMark(ev.id), ...md.split('\n'), '']); inserted++; }
      states.push({ eventId: ev.id, hash }); parsed = parse(lines.join('\n'));
    }
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', states,
    inserted, updated, deleted, preserved, conflicts };
}

export function mergeDateIndex(text, { firstDay, urlKey, title, fileName, mode }) {
  const mark = idxMark(urlKey);
  const base = fileName.replace(/\.md$/, ''), label = String(title || urlKey).replace(/[\[\]]/g, '\\$&');
  const link = mode === 'obsidian' ? `[[${base}]]` : `[${label}](${encodeURI(fileName)})`;
  // 已有本文章的条目时**原地更新**（标题/文件名变了要跟着改），而不是跳过 ——
  // 否则改标题重同步后，索引里的链接会永远停在旧值。
  const entry = `- ${link} ${mark}`, current = String(text || '');
  if (current.includes(mark)) {
    const lines = current.split('\n'), at = lines.findIndex((line) => line.includes(mark));
    if (at < 0 || lines[at].trim() === entry) return { text, changed: false };
    lines[at] = entry;
    return { text: lines.join('\n'), changed: true };
  }
  const out = current || `---\ndate: ${firstDay}\ntags: [reading, contextflow]\n---\n\n# ${firstDay} 阅读记录\n`;
  return { text: `${out.trimEnd()}\n\n${entry}\n`, changed: true };
}

export function initialFileName(title, urlKey) { return safeMarkdownFilename(title, urlKey); }
export const hasArticleMarker = (text, urlKey) => String(text || '').includes(artMark(urlKey));
