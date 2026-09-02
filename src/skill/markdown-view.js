// AI 回答的安全 Markdown 预览。
//
// 模型输出是不可信输入。这里刻意不用 innerHTML，也不引入“Markdown → HTML”后再
// 消毒的双重复杂度；只用 DOM API 创建一小组明确允许的元素。原始 HTML、图片、
// 非 http(s) 链接都只会成为普通文字。
import { T } from './theme.js';

export const MARKDOWN_CSS = `
  .md{min-width:0;color:${T.ink};font:13.5px/1.72 ${T.sans};overflow-wrap:anywhere}
  .md > :first-child{margin-top:0}.md > :last-child{margin-bottom:0}
  .md p{margin:0 0 .72em}.md h1,.md h2,.md h3,.md h4{margin:1.1em 0 .45em;color:${T.ink};
    font-family:${T.serif};font-weight:650;line-height:1.38;letter-spacing:-.01em}
  .md h1{font-size:1.18em}.md h2{font-size:1.12em}.md h3,.md h4{font-size:1.04em}
  .md ul,.md ol{margin:.35em 0 .8em;padding-left:1.45em}.md li{margin:.22em 0;padding-left:.08em}
  .md blockquote{margin:.55em 0 .8em;padding:.05em 0 .05em 10px;border-left:2px solid ${T.lineStrong};
    color:${T.quote};font-family:${T.serif}}
  .md code{padding:.12em .34em;border:1px solid ${T.lineSoft};border-radius:4px;background:${T.sunk};
    color:${T.inkSoft};font:12px/1.5 ${T.mono}}
  .md pre{max-width:100%;margin:.65em 0 .9em;padding:10px 11px;overflow-x:auto;border:1px solid ${T.line};
    border-radius:6px;background:${T.sunk};white-space:pre;overscroll-behavior-x:contain}
  .md pre code{padding:0;border:0;background:transparent;color:${T.inkSoft};font:12px/1.58 ${T.mono}}
  .md a{color:${T.blue};text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
  .md a:hover{color:${T.accent}}.md a:focus-visible{outline:2px solid ${T.focusLine};outline-offset:2px;border-radius:2px}
  .md strong{font-weight:700;color:${T.ink}}.md em{font-style:italic}
`;

const MAX_SOURCE = 200000;
const MAX_INLINE_DEPTH = 12;

const text = (value) => document.createTextNode(value);

function safeHref(raw) {
  try {
    const url = new URL(String(raw).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** 行内子集；返回节点数组，不接触 HTML parser。 */
function inline(source, depth = 0) {
  const value = String(source || '');
  if (!value || depth >= MAX_INLINE_DEPTH) return [text(value)];
  const out = [];
  // 图片语法不进入链接分支，完整保留为文字。
  const token = /(!?\[[^\]\n]*\]\([^\n)]*(?:\)[^\n)]*)?\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let at = 0;
  for (const match of value.matchAll(token)) {
    if (match.index > at) out.push(text(value.slice(at, match.index)));
    const raw = match[0];
    if (raw.startsWith('![')) {
      out.push(text(raw));
    } else if (raw.startsWith('[')) {
      const parts = raw.match(/^\[([^\]]*)\]\((.*)\)$/s);
      const href = parts && safeHref(parts[2]);
      if (href) {
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.append(...inline(parts[1], depth + 1)); out.push(a);
      } else out.push(text(raw));
    } else if (raw.startsWith('`')) {
      const code = document.createElement('code'); code.textContent = raw.slice(1, -1); out.push(code);
    } else {
      const strong = raw.startsWith('**') || raw.startsWith('__');
      const el = document.createElement(strong ? 'strong' : 'em');
      el.append(...inline(raw.slice(strong ? 2 : 1, strong ? -2 : -1), depth + 1)); out.push(el);
    }
    at = match.index + raw.length;
  }
  if (at < value.length) out.push(text(value.slice(at)));
  return out;
}

function appendLines(el, lines) {
  lines.forEach((line, index) => {
    if (index) el.append(document.createElement('br'));
    el.append(...inline(line));
  });
}

/** @param {HTMLElement} target @param {string} source */
export function renderMarkdownInto(target, source) {
  target.replaceChildren();
  target.classList.add('md');
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_SOURCE).split('\n');
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }

    const fence = lines[i].match(/^\s*```/);
    if (fence) {
      const body = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = body.join('\n'); pre.append(code); frag.append(pre); continue;
    }

    const heading = lines[i].match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`);
      h.append(...inline(heading[2])); frag.append(h); i++; continue;
    }

    const quote = lines[i].match(/^\s*>\s?(.*)$/);
    if (quote) {
      const body = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*>\s?(.*)$/); if (!m) break;
        body.push(m[1]); i++;
      }
      const el = document.createElement('blockquote'); appendLines(el, body); frag.append(el); continue;
    }

    const list = lines[i].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if (list) {
      const ordered = !!list[2], el = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
        if (!m || !!m[2] !== ordered) break;
        const li = document.createElement('li'); li.append(...inline(m[3])); el.append(li); i++;
      }
      frag.append(el); continue;
    }

    const body = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*(?:#{1,4}\s+|```|>\s?|(?:[-+*]|\d+\.)\s+)/.test(lines[i])) body.push(lines[i++]);
    const p = document.createElement('p'); appendLines(p, body.length ? body : [lines[i++]]); frag.append(p);
  }
  target.append(frag);
  return target;
}
