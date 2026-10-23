// Shared safe preview: Markdown tokens become allowlisted, passive DOM nodes.
// Raw HTML and remote images stay text; only untrusted-mode KaTeX parses markup.
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { appendMath, mathPlugin } from './markdown-math.js';
import { T } from './theme.js';

export const MARKDOWN_CSS = `
  .md{min-width:0;color:${T.ink};font:13.5px/1.72 ${T.sans};overflow-wrap:anywhere}
  .md > :first-child{margin-top:0}.md > :last-child{margin-bottom:0}
  .md p{margin:0 0 .72em}.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:1.1em 0 .45em;color:${T.ink};
    font-family:${T.serif};font-weight:650;line-height:1.38;letter-spacing:-.01em}
  .md h1{font-size:1.25em}.md h2{font-size:1.16em}.md h3{font-size:1.08em}.md h4,.md h5,.md h6{font-size:1em}
  .md ul,.md ol{margin:.35em 0 .8em;padding-left:1.6em}.md li{margin:.22em 0;padding-left:.08em}
  .md li > p{margin:.35em 0}.md li > :last-child{margin-bottom:0}
  .md blockquote{margin:.55em 0 .8em;padding:.05em 0 .05em 10px;border-left:2px solid ${T.lineStrong};
    color:${T.quote};font-family:${T.serif}}.md blockquote > :last-child{margin-bottom:0}
  .md code{padding:.12em .34em;border:1px solid ${T.lineSoft};border-radius:4px;background:${T.sunk};
    color:${T.inkSoft};font:12px/1.5 ${T.mono}}
  .md pre{max-width:100%;margin:.65em 0 .9em;padding:10px 11px;overflow-x:auto;border:1px solid ${T.line};
    border-radius:6px;background:${T.sunk};white-space:pre;overscroll-behavior-x:contain}
  .md pre code{padding:0;border:0;background:transparent;color:${T.inkSoft};font:12px/1.58 ${T.mono}}
  .md .md-table{max-width:100%;margin:.65em 0 .9em;overflow-x:auto;border:1px solid ${T.line};
    border-radius:6px;overscroll-behavior-x:contain}
  .md .md-table:focus-visible,.md .md-math-display:focus-visible{outline:2px solid ${T.focusLine};outline-offset:-2px}
  .md table{width:100%;border-collapse:collapse;font:inherit;line-height:1.55}
  .md th,.md td{min-width:4em;padding:7px 9px;border-right:1px solid ${T.line};border-bottom:1px solid ${T.line};
    text-align:left;vertical-align:top;white-space:normal;overflow-wrap:break-word}
  .md th{background:${T.sunk};color:${T.ink};font-weight:650}
  .md tr > :last-child{border-right:0}.md tbody tr:last-child > td{border-bottom:0}
  .md a{color:${T.blue};text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
  .md a:hover{color:${T.accent}}.md a:focus-visible{outline:2px solid ${T.focusLine};outline-offset:2px;border-radius:2px}
  .md strong{font-weight:700;color:${T.ink}}.md em{font-style:italic}.md s{color:${T.quote}}
  .md hr{height:0;margin:1em 0;border:0;border-top:1px solid ${T.line}}
  .md .md-task-item{list-style:none}.md .md-task-checkbox{appearance:auto;display:inline-block;width:13px;height:13px;
    min-height:0;margin:0 .5em 0 -1.45em;padding:0;vertical-align:middle;accent-color:${T.accent}}
  .md .md-alert{padding:10px 12px;border-radius:0 6px 6px 0;background:${T.sunk};font-family:${T.sans};border-color:${T.blue}}
  .md .md-alert-warning,.md .md-alert-caution{border-color:${T.accent}}
  .md .md-alert-title{font-weight:650;color:${T.inkSoft};margin:0 0 .35em}
  .md .md-footnotes{margin-top:1em;color:${T.inkSoft};font-size:.92em}
  .md .md-footnote-link{appearance:none;display:inline;padding:0 2px;border:0;background:transparent;color:${T.blue};
    font:inherit;cursor:pointer;line-height:inherit;min-height:0;text-decoration:underline;text-underline-offset:2px}
  .md .md-footnote-link:focus-visible{outline:2px solid ${T.focusLine};outline-offset:2px}
  .md .md-math{color:inherit;overflow-wrap:normal;text-indent:0;font-style:normal}
  .md .md-math math{font-size:1.08em;font-family:"STIX Two Math","Cambria Math","Latin Modern Math",math}
  .md .md-math-inline{display:inline-block;max-width:100%;overflow-x:auto;vertical-align:middle;white-space:nowrap;
    overscroll-behavior-x:contain;line-height:normal;padding:.12em 0}
  .md .md-math-display{display:block;max-width:100%;margin:.8em 0;padding:8px 2px;overflow-x:auto;
    overscroll-behavior-x:contain;white-space:nowrap;line-height:normal}
  .md .md-math-display math{margin:0 auto;min-width:max-content}
  .md .md-math-fallback{font:12px/1.65 ${T.mono};white-space:pre-wrap;overflow-wrap:anywhere;color:${T.inkSoft}}
`;

const MAX_SOURCE = 200000;
const parser = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false, maxNesting: 24 })
  .use(mathPlugin).use(footnote);

function splitTableRow(source) {
  const value = source.trim(), cells = [];
  let cell = '', last = -1;
  for (let i = 0; i < value.length; i++) {
    const next = value[i + 1];
    if (value[i] === '\\' && (next === '\\' || next === '|')) {
      cell += next === '|' ? '|' : '\\\\'; i++;
    } else if (value[i] === '|') { cells.push(cell.trim()); cell = ''; last = i; }
    else cell += value[i];
  }
  if (last < 0) return null;
  cells.push(cell.trim());
  if (value.startsWith('|')) cells.shift();
  if (last === value.length - 1) cells.pop();
  return cells;
}

// Retain the existing escaped-pipe and no-blank-line table compatibility. All
// cells still use the same Markdown inline parser, including math and links.
parser.block.ruler.at('table', (state, start, end, silent) => {
  if (start + 1 >= end || state.sCount[start] - state.blkIndent >= 4) return false;
  const line = n => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
  const separators = splitTableRow(line(start + 1)), headers = splitTableRow(line(start));
  if (!separators?.length || separators.length > 128 || headers?.length !== separators.length
    || !separators.every(value => /^:?-+:?$/.test(value))) return false;
  if (silent) return true;
  const alignments = separators.map(value => value.endsWith(':') ? value.startsWith(':') ? 'center' : 'right' : 'left');
  const row = (cells, header) => {
    state.push('tr_open', 'tr', 1);
    alignments.forEach((align, i) => {
      const tag = header ? 'th' : 'td';
      state.push(`${tag}_open`, tag, 1).attrSet('style', `text-align:${align}`);
      const token = state.push('inline', '', 0); token.content = cells[i] || ''; token.children = [];
      state.push(`${tag}_close`, tag, -1);
    });
    state.push('tr_close', 'tr', -1);
  };
  state.push('table_open', 'table', 1);
  state.push('thead_open', 'thead', 1); row(headers, true); state.push('thead_close', 'thead', -1);
  state.push('tbody_open', 'tbody', 1);
  let next = start + 2;
  const terminators = state.md.block.ruler.getRules('blockquote');
  for (; next < end && (next - start) * alignments.length < 10000; next++) {
    if (state.sCount[next] < state.blkIndent || state.isEmpty(next)
      || terminators.some(rule => rule(state, next, end, true))) break;
    const cells = splitTableRow(line(next)); if (!cells) break;
    row(cells, false);
  }
  state.push('tbody_close', 'tbody', -1); state.push('table_close', 'table', -1);
  state.line = next; return true;
}, { alt: ['paragraph', 'reference'] });

const TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote',
  'strong','em','s','table','thead','tbody','tr','th','td']);
const ALERTS = { NOTE: '提示', TIP: '技巧', IMPORTANT: '重要', WARNING: '注意', CAUTION: '警告' };
const element = (tag, className, value) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value != null) el.textContent = value;
  return el;
};

function safeHref(raw) {
  try {
    const url = new URL(String(raw).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function prepareTokens(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'inline') continue;
    if (tokens[i - 1]?.type === 'paragraph_open' && tokens[i - 2]?.type === 'list_item_open') {
      const first = token.children?.[0], match = first?.type === 'text' && first.content.match(/^\[([ xX])\]\s+/);
      if (match) {
        first.content = first.content.slice(match[0].length);
        tokens[i - 2].meta = { task: match[1].toLowerCase() === 'x' };
      }
    }
    if (tokens[i - 2]?.type === 'blockquote_open') {
      const first = token.children?.[0], match = first?.type === 'text' && first.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/);
      if (match) {
        tokens[i - 2].meta = { alert: match[1] };
        token.children.shift();
        if (['softbreak','hardbreak'].includes(token.children[0]?.type)) token.children.shift();
      }
    }
  }
}

function renderTokens(parent, tokens, context) {
  const stack = [parent];
  const current = () => stack[stack.length - 1];
  for (const token of tokens) {
    if (token.hidden) continue;
    if (token.type === 'inline') { renderTokens(current(), token.children || [], context); continue; }
    if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
    if (token.type === 'cf_math') {
      appendMath(current(), token.content, token.meta.display, token.meta.raw, context.math); continue;
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      if (token.type === 'fence' && token.info.trim().toLowerCase() === 'math') {
        appendMath(current(), token.content.trim(), true, token.content, context.math); continue;
      }
      const pre = element('pre'), code = element('code', '', token.content.replace(/\n$/, ''));
      const language = token.info?.trim().split(/\s+/)[0];
      if (language && /^[a-z\d_+-]{1,40}$/i.test(language)) code.className = `language-${language}`;
      pre.append(code); current().append(pre); continue;
    }
    if (token.type === 'text' || token.type === 'html_inline' || token.type === 'html_block') {
      current().append(document.createTextNode(token.content)); continue;
    }
    if (token.type === 'code_inline') { current().append(element('code', '', token.content)); continue; }
    if (token.type === 'softbreak' || token.type === 'hardbreak') { current().append(element('br')); continue; }
    if (token.type === 'hr') { current().append(element('hr')); continue; }
    if (token.type === 'image') {
      current().append(document.createTextNode(`![${token.content}](${token.attrGet('src') || ''})`)); continue;
    }
    if (token.type === 'footnote_ref' || token.type === 'footnote_anchor') {
      const id = token.meta.id, ref = token.type === 'footnote_ref';
      const button = element('button', 'md-footnote-link', ref ? `[${id + 1}]` : '↩'); button.type = 'button';
      button.setAttribute('aria-label', ref ? `查看脚注 ${id + 1}` : `返回脚注 ${id + 1} 的引用`);
      button.onclick = () => {
        const destination = (ref ? context.notes : context.refs).get(id);
        destination?.scrollIntoView?.({ block: 'nearest' }); destination?.focus({ preventScroll: true });
      };
      if (ref) {
        const sup = element('sup'); sup.append(button); current().append(sup);
        if (!context.refs.has(id)) context.refs.set(id, button);
      } else current().append(button);
      continue;
    }
    if (token.type === 'footnote_block_open') {
      const section = element('section', 'md-footnotes'), list = element('ol');
      section.setAttribute('aria-label', '脚注'); section.append(element('hr'), list); current().append(section); stack.push(list); continue;
    }
    if (token.type === 'footnote_open') {
      const li = element('li'); li.tabIndex = -1; context.notes.set(token.meta.id, li); current().append(li); stack.push(li); continue;
    }
    if (token.nesting === 1) {
      let el;
      if (token.type === 'link_open') {
        const href = safeHref(token.attrGet('href'));
        el = element(href ? 'a' : 'span');
        if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        const title = token.attrGet('title'); if (title) el.title = title;
      } else if (TAGS.has(token.tag)) el = element(token.tag);
      else el = element('span');
      if (token.tag === 'table') {
        const wrap = element('div', 'md-table'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '表格');
        wrap.append(el); current().append(wrap);
      } else current().append(el);
      if (token.tag === 'ol' && /^\d+$/.test(token.attrGet('start') || '')) el.start = Number(token.attrGet('start'));
      if (token.tag === 'th' || token.tag === 'td') {
        if (token.tag === 'th') el.scope = 'col';
        el.style.textAlign = (token.attrGet('style') || '').match(/^text-align:(left|center|right)$/)?.[1] || 'left';
      }
      if (token.meta?.task != null) {
        el.className = 'md-task-item'; const box = element('input', 'md-task-checkbox');
        box.type = 'checkbox'; box.disabled = true; box.checked = token.meta.task;
        box.setAttribute('aria-label', box.checked ? '已完成' : '未完成'); el.append(box);
      }
      if (token.meta?.alert) {
        el.className = `md-alert md-alert-${token.meta.alert.toLowerCase()}`;
        el.append(element('p', 'md-alert-title', ALERTS[token.meta.alert]));
      }
      stack.push(el);
    }
  }
}

/** Stored/exported Markdown remains untouched; only the preview changes. */
export function renderMarkdownInto(target, source) {
  target.replaceChildren(); target.classList.add('md');
  const value = String(source ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_SOURCE);
  const fragment = document.createDocumentFragment();
  try {
    const tokens = parser.parse(value, {}); prepareTokens(tokens);
    renderTokens(fragment, tokens, { math: { count: 0, chars: 0 }, notes: new Map(), refs: new Map() });
  } catch {
    // A malformed/unsupported construct must never hide the rest of the answer.
    fragment.replaceChildren(document.createTextNode(value));
  }
  target.append(fragment); return target;
}
