// Parse math before Markdown consumes backslash escapes; never scan code tokens.
import katex from 'katex';

const MAX_FORMULA = 8000;
const MAX_FORMULAS = 200;
const MAX_MATH_CHARS = 60000;

function closingAt(source, delimiter, from) {
  let at = from;
  while ((at = source.indexOf(delimiter, at)) >= 0) {
    let slashes = 0;
    for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) return at;
    at += delimiter.length;
  }
  return -1;
}

export function mathPlugin(md) {
  md.inline.ruler.before('escape', 'cf_math', (state, silent) => {
    const start = state.pos, source = state.src;
    const open = source.startsWith('\\(', start) ? '\\('
      : source.startsWith('\\[', start) ? '\\['
        : source.startsWith('$$', start) ? '$$' : source[start] === '$' ? '$' : '';
    if (!open) return false;
    const close = { '\\(': '\\)', '\\[': '\\]', '$$': '$$', '$': '$' }[open];
    const from = start + open.length;
    if (open === '$' && (!source[from] || /\s|\$/.test(source[from]))) return false;
    const bounded = source.slice(from, Math.min(state.posMax, from + MAX_FORMULA + close.length));
    let end = closingAt(bounded, close, 0);
    while (open === '$' && end >= 0 && (/\s/.test(bounded[end - 1]) || /\d/.test(bounded[end + 1] || ''))) {
      end = closingAt(bounded, close, end + 1);
    }
    if (end <= 0 || (open === '$' && bounded.slice(0, end).includes('\n'))) return false;
    if (!silent) {
      const token = state.push('cf_math', '', 0);
      token.content = bounded.slice(0, end);
      token.meta = { display: open === '$$' || open === '\\[', raw: source.slice(start, from + end + close.length) };
    }
    state.pos = from + end + close.length;
    return true;
  });

  md.block.ruler.before('fence', 'cf_math_block', (state, start, endLine, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const line = n => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
    const first = line(start), open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : '';
    if (!open) return false;
    const close = open === '$$' ? '$$' : '\\]';
    const body = [];
    let size = 0;
    for (let next = start; next < endLine; next++) {
      if (state.sCount[next] < state.blkIndent && !state.isEmpty(next)) return false;
      const value = next === start ? first.slice(open.length) : line(next);
      const end = closingAt(value, close, 0);
      if (end >= 0) {
        if (value.slice(end + close.length).trim()) return false;
        body.push(value.slice(0, end));
        if (!body.join('\n').trim()) return false;
        if (silent) return true;
        const token = state.push('cf_math', '', 0);
        token.block = true; token.content = body.join('\n').trim(); token.map = [start, next + 1];
        token.meta = { display: true, raw: `${open}${body.join('\n')}${close}` };
        state.line = next + 1;
        return true;
      }
      size += value.length + 1;
      if (size > MAX_FORMULA) return false;
      body.push(value);
    }
    return false;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

export function appendMath(parent, source, display, raw, budget) {
  const el = document.createElement('span');
  el.className = display ? 'md-math md-math-display' : 'md-math md-math-inline';
  const fallback = () => {
    el.classList.add('md-math-fallback'); el.textContent = raw;
    el.title = '公式暂无法渲染，已保留原文';
  };
  budget.count++; budget.chars += source.length;
  if (source.length > MAX_FORMULA || budget.count > MAX_FORMULAS || budget.chars > MAX_MATH_CHARS) fallback();
  else {
    try {
      // Chrome 111+ supports native MathML: no CDN, font requests or Shadow DOM
      // font/CSP dependencies. Only KaTeX output enters the HTML parser.
      const markup = katex.renderToString(source, {
        output: 'mathml', displayMode: display, throwOnError: true,
        trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, macros: {},
      });
      if (markup.length > 200000) throw new Error('Formula output limit');
      const template = document.createElement('template');
      template.innerHTML = markup;
      el.append(template.content);
    } catch { fallback(); }
  }
  if (display) {
    el.tabIndex = 0; el.setAttribute('role', 'region'); el.setAttribute('aria-label', '公式，可横向滚动');
  }
  parent.append(el);
}
