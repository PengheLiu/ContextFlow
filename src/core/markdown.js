// 浏览器与服务端共用的纯 Markdown 语义。
// 不含文件系统标记；浏览器导出默认只写用户能读懂的正文。

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const quote = (s) => oneLine(s).split('\n').map((l) => `> ${l}`).join('\n');

/** 可见、可点击且不会被危险 scheme 伪装的原文链接。 */
export function renderSourceMarkdown(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `> 来源：<${url.href}>`;
  } catch { return ''; }
}

export const CATEGORIES = [
  { key: 'summary', label: '速览', actions: ['summary'] },
  { key: 'translate', label: '翻译', actions: ['translate'] },
  { key: 'explain', label: '解释', actions: ['explain'] },
  { key: 'comments', label: '批注', actions: ['highlight', 'comment'] },
  { key: 'note', label: '总结', actions: ['note'] },
];

const at = (e) => e.anchor?.start ?? Number.MAX_SAFE_INTEGER;

export function groupByCategory(events) {
  const live = events.filter((e) => !e.deletedAt);
  const out = new Map();
  for (const c of CATEGORIES) {
    let mine = live.filter((e) => c.actions.includes(e.action));
    if (!mine.length) continue;
    if (c.key === 'comments') {
      const hs = mine.filter((e) => e.action === 'highlight').sort((a, b) => at(a) - at(b));
      const cs = mine.filter((e) => e.action === 'comment');
      mine = hs.flatMap((h) => [h, ...cs.filter((x) => x.parentId === h.id)]);
      mine.push(...cs.filter((x) => !mine.includes(x)));
    } else mine.sort((a, b) => at(a) - at(b));
    out.set(c.key, mine);
  }
  return out;
}

export function renderEventMarkdown(ev) {
  const v = String(ev.value ?? '').trim();
  if (!v && ev.extra?.status) {
    const why = ev.extra.status === 'deferred' ? '离线待处理' : (ev.extra.error || '未完成');
    return `> ⚠ ${why}`;
  }
  switch (ev.action) {
    case 'highlight': return quote(ev.text);
    case 'comment': return v ? `💬 ${v}` : '';
    case 'summary': return v ? v.split('\n').map((l) => `> ${l}`).join('\n') : '';
    case 'note': return v;
    case 'translate': return v ? `${quote(ev.text)}\n${v}` : '';
    case 'explain': {
      const q = oneLine(ev.extra?.question) || '这段在讲什么';
      const supplement = String(ev.extra?.supplement ?? '').trim();
      return v ? `**❓ ${q}**\n${quote(ev.text)}\n${v}`
        + (supplement ? `\n\n**我的补充**\n${supplement}` : '') : '';
    }
    default: return '';
  }
}

export function renderArticleMarkdown({ title, url, events }) {
  const source = renderSourceMarkdown(url);
  const lines = [`# ${oneLine(title) || '未命名文章'}`, ...(source ? ['', source] : [])];
  const groups = groupByCategory(events);
  for (const c of CATEGORIES) {
    const mine = groups.get(c.key);
    if (!mine?.length) continue;
    const blocks = mine.map(renderEventMarkdown).filter(Boolean);
    if (!blocks.length) continue;
    lines.push('', `## ${c.label}`, '', blocks.join('\n\n'));
  }
  return lines.join('\n').trim() + '\n';
}

export function safeMarkdownFilename(title, urlKey = '') {
  // 用转义写控制字符，不能把字面 NUL 放进源码（Git 会把文件判成二进制）。
  let s = oneLine(title).replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, 60).join('').replace(/^\.+|\.+$/g, '').trim();
  if (!s) s = `context-${String(urlKey).replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'article'}`;
  return `${s}.md`;
}
