// 锚定核心：把选区序列化为 W3C 风格 selector，并在页面重新加载后解析回 Range。
// 纯 DOM 操作，无依赖 —— userscript（MAIN world）和扩展（ISOLATED world）通用。
//
// 设计要点见 DESIGN.md §3。关键性能约束：arxiv /html/ 正文实测 41.7 万字符，
// 因此文本索引必须单遍构建一次、所有锚点复用。

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION',
  'CANVAS', 'SVG', 'IFRAME', 'AUDIO', 'VIDEO', 'HEAD',
]);

// 跨这些标签的边界时插入 '\n'，避免上下文无关的两段文字被拼成一个词
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TD', 'TH', 'TR', 'UL',
]);

export const CTX_LEN = 48; // prefix/suffix 上下文长度

/** 找到最近的块级祖先，用于判断是否跨块。带缓存，避免对每个文本节点重复上溯。 */
function nearestBlock(el, cache) {
  let cur = el;
  const chain = [];
  while (cur) {
    const hit = cache.get(cur);
    if (hit !== undefined) {
      for (const e of chain) cache.set(e, hit);
      return hit;
    }
    chain.push(cur);
    if (BLOCK_TAGS.has(cur.tagName)) break;
    cur = cur.parentElement;
  }
  const block = cur || null;
  for (const e of chain) cache.set(e, block);
  return block;
}

/**
 * 单遍构建归一化文本索引。
 * 归一化 = 空白折叠为单个空格（跨块处为 '\n'），这让 exact 引文可读、且抗 HTML 重排版。
 *
 * @returns {{text:string, segs:Array, nodeSegs:Map<Text,Array>}}
 *   segs 每项 {node, nodeStart, textStart, len}，表示一段「归一化偏移 ↔ 节点偏移」线性对应的区间。
 *   折叠掉的空白会打断区间，因此 segs 数量取决于空白密度，正常正文远小于字符数。
 */
export function buildTextIndex(root = document.body) {
  const blockCache = new Map();
  const segs = [];
  const nodeSegs = new Map();
  let out = '';
  let lastWasSpace = true; // 开头的空白直接丢弃
  let prevBlock = null;
  let seg = null;

  const closeSeg = () => { seg = null; };
  const pushChar = (ch) => { out += ch; };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      // 排除我们自己注入的 UI，否则工具条文字会污染索引
      if (p.closest('[data-contextflow]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const raw = n.nodeValue;
    if (!raw) continue;

    const block = nearestBlock(n.parentElement, blockCache);
    if (prevBlock && block !== prevBlock && !lastWasSpace) {
      pushChar('\n');
      lastWasSpace = true;
      closeSeg();
    }
    prevBlock = block;

    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      const isSpace = c === ' ' || c === '\t' || c === '\n' || c === '\r' ||
                      c === '\f' || c === ' ';
      if (isSpace) {
        if (!lastWasSpace) { pushChar(' '); lastWasSpace = true; }
        closeSeg(); // 折叠打断线性对应
        continue;
      }
      lastWasSpace = false;
      if (!seg) {
        seg = { node: n, nodeStart: i, textStart: out.length, len: 0 };
        segs.push(seg);
        let arr = nodeSegs.get(n);
        if (!arr) nodeSegs.set(n, arr = []);
        arr.push(seg);
      }
      pushChar(c);
      seg.len++;
    }
    closeSeg();
  }

  return { text: out, segs, nodeSegs };
}

/** 二分查找：归一化偏移 → {node, offset}。落在折叠空白里时就近吸附。 */
export function locate(index, off) {
  const { segs } = index;
  if (!segs.length) return null;
  let lo = 0, hi = segs.length - 1, pick = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (off < s.textStart) { hi = mid - 1; }
    else if (off > s.textStart + s.len) { lo = mid + 1; }
    else { pick = s; break; }
  }
  if (!pick) pick = segs[Math.min(lo, segs.length - 1)];
  const delta = Math.max(0, Math.min(pick.len, off - pick.textStart));
  return { node: pick.node, offset: pick.nodeStart + delta };
}

/** {node, offset} → 归一化偏移。找不到精确对应时吸附到最近区间边界。 */
export function charOffsetOf(index, node, offset) {
  const arr = index.nodeSegs.get(node);
  if (!arr) return null;
  for (const s of arr) {
    if (offset >= s.nodeStart && offset <= s.nodeStart + s.len) {
      return s.textStart + (offset - s.nodeStart);
    }
  }
  // offset 落在被折叠的空白中：取第一个起点在其后的区间
  for (const s of arr) if (s.nodeStart > offset) return s.textStart;
  const last = arr[arr.length - 1];
  return last.textStart + last.len;
}

// 吸附用的「词字符」：拉丁字母、数字、下划线。
// 刻意排除 CJK —— 中文/日文没有空格分词，一旦纳入就会顺着连续汉字
// 把整句甚至整段扩进来。中文选区本来就是逐字精确的，不该动。
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;
const isWordChar = (c) => !!c && /[\p{L}\p{N}_]/u.test(c) && !CJK.test(c);
const SNAP_MAX = 40;   // 每侧外扩上限，防病态输入

/**
 * 把落在词中间的选区边界外扩到完整单词。
 *
 * 拖拽选区是逐字符的，不会自动吸附词边界 —— 快速拖选起手偏一个字符，
 * 存下来的引文就是 "ttacker's server" 这种。实测中同一分钟内产生的四条
 * 高亮里有三条这样，是同步出去的引文质量的主要来源问题。
 *
 * 只在**两侧都是词字符**时才扩（即确实在词内部）；边界本就落在空白或
 * 标点上时不动。连字符与撇号不算词字符，所以选 "distillation" 不会被扩成
 * "anti-distillation"，而选 "ttacker's" 会把开头的 a 补回来。
 */
export function snapToWords(text, start, end) {
  let s = start, e = end;
  let n = 0;
  while (s > 0 && n++ < SNAP_MAX && isWordChar(text[s - 1]) && isWordChar(text[s])) s--;
  n = 0;
  while (e < text.length && n++ < SNAP_MAX && isWordChar(text[e - 1]) && isWordChar(text[e])) e++;
  return { start: s, end: e };
}

/**
 * 把 Range 序列化为锚点。返回 null 表示选区不落在索引覆盖的正文里。
 * @param {object} [opts] snap=false 可关闭词边界吸附
 */
/**
 * 把任意 DOM 边界 `(node, offset)` 归一成索引里的字符偏移。
 *
 * 文本节点走 charOffsetOf 的查表路径。**元素节点必须另算** ——
 * nodeSegs 只以文本节点为键，而拖选到段尾时 range.endContainer 往往是 `<p>`
 * 而不是文本节点（三击选段、跨段拖选也一样）。查表拿不到就返回 null，
 * 于是整个锚点作废：实测表现为一整段的翻译记录 anchor=null，
 * 原文上没有标记、面板里也点不动。
 *
 * 元素边界的 DOM 语义是「位于第 offset 个子节点之前」（offset 等于子节点数时
 * 位于最后一个之后）。这种边界永远落在两个子节点之间，不会切开某个 seg，
 * 所以只需在按文档顺序排列的 segs 里二分出分界点：
 *   起点 → 取其后第一个 seg 的开头
 *   终点 → 取其前最后一个 seg 的末尾
 *
 * @param {'start'|'end'} side 元素边界向哪一侧收
 */
export function boundaryOffset(index, node, offset, side = 'start') {
  if (!node) return null;
  // 先查表再看 nodeType：能在 nodeSegs 里查到的，按构造就是文本节点。
  // 这样既省一次 nodeType 判断，也让本函数在没有 document 的环境里仍能工作
  // （合成索引的单元测试就是这种情况）。
  if (index.nodeSegs?.has(node)) return charOffsetOf(index, node, offset);
  if (node.nodeType === 3) return charOffsetOf(index, node, offset);

  const { segs } = index;
  if (!segs?.length) return null;

  let probe;
  try {
    probe = document.createRange();
    probe.setStart(node, offset);
    probe.collapse(true);
  } catch { return null; }

  // segs 按文档顺序 → 二分。lo = 最后一个「起点 ≤ 边界」的下标
  let lo = -1, hi = segs.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    let cmp;
    try {
      cmp = probe.comparePoint(segs[mid].node, segs[mid].nodeStart);
    } catch {
      cmp = -1;         // 不可比（已脱离文档等）：当作在边界之前
    }
    if (cmp <= 0) lo = mid; else hi = mid;
  }

  if (side === 'end') {
    if (lo < 0) return null;
    const s = segs[lo];
    return s.textStart + s.len;
  }
  if (hi >= segs.length) return null;
  return segs[hi].textStart;
}

export function serializeRange(range, index, opts = {}) {
  let start = boundaryOffset(index, range.startContainer, range.startOffset, 'start');
  let end = boundaryOffset(index, range.endContainer, range.endOffset, 'end');
  if (start == null || end == null || end <= start) return null;
  const { text } = index;
  if (opts.snap !== false) ({ start, end } = snapToWords(text, start, end));
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CTX_LEN), start),
    suffix: text.slice(end, Math.min(text.length, end + CTX_LEN)),
    start,
    end,
  };
}

function rangeFrom(index, start, end) {
  const a = locate(index, start);
  const b = locate(index, end);
  if (!a || !b) return null;
  try {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r.collapsed ? null : r;
  } catch { return null; }
}

/** 收集 needle 在 hay 中的全部出现位置（上限 200，防病态输入） */
function allIndexOf(hay, needle, cap = 200) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < cap) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/** 公共后缀长度 */
function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
/** 公共前缀长度 */
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * 三层降级解析锚点。
 * @returns {{range:Range, tier:'position'|'quote'|'fuzzy'}|null} null = 失锚(orphan)
 */
export function resolveAnchor(anchor, index) {
  const { text } = index;
  const { exact, prefix = '', suffix = '', start, end } = anchor;
  if (!exact) return null;

  // 第 1 层：位置快路径 —— 直接校验偏移处是否就是原文
  if (Number.isInteger(start) && text.slice(start, end) === exact) {
    const r = rangeFrom(index, start, end);
    if (r) return { range: r, tier: 'position' };
  }

  // 第 2 层：引文搜索。单次命中直接用；多次命中用上下文打分选唯一赢家。
  const hits = allIndexOf(text, exact);
  if (hits.length === 1) {
    const r = rangeFrom(index, hits[0], hits[0] + exact.length);
    if (r) return { range: r, tier: 'quote' };
  } else if (hits.length > 1) {
    let best = -1, bestScore = -Infinity, tie = false;
    for (const h of hits) {
      const pre = text.slice(Math.max(0, h - prefix.length), h);
      const suf = text.slice(h + exact.length, h + exact.length + suffix.length);
      // 上下文匹配度（整数字符数）主导；位置接近度严格落在 [0,0.5)，
      // 只能打破上下文完全相同的平局，绝不能压过上下文差异。
      // 注意：start 可能是过期的大值，惩罚项必须先归一化再钳制。
      const near = Number.isInteger(start)
        ? Math.min(1, Math.abs(h - start) / Math.max(1, text.length)) * 0.5
        : 0.5;
      const score = commonSuffix(pre, prefix) + commonPrefix(suf, suffix) - near;
      if (score > bestScore) { bestScore = score; best = h; tie = false; }
      else if (score === bestScore) { tie = true; }
    }
    if (best >= 0 && !tie) {
      const r = rangeFrom(index, best, best + exact.length);
      if (r) return { range: r, tier: 'quote' };
    }
  }

  // 第 3 层：模糊 —— 忽略大小写与空白差异再搜一次。
  // 只在前两层失败时才做，且仍是 indexOf 单遍，不做全文编辑距离。
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  const loose = getLooseView(index);
  const li = loose.text.indexOf(norm(exact).trim());
  if (li !== -1) {
    const s = loose.map[li] ?? null;
    const eIdx = Math.min(loose.map.length - 1, li + norm(exact).trim().length - 1);
    const e = loose.map[eIdx];
    if (s != null && e != null) {
      const r = rangeFrom(index, s, e + 1);
      if (r) return { range: r, tier: 'fuzzy' };
    }
  }

  return null; // orphan：原文已改动，不渲染但需在侧栏提示，绝不静默丢弃
}

/** 惰性构建「小写+空白折叠」视图及其回映射，仅第 3 层用得到 */
function getLooseView(index) {
  if (index._loose) return index._loose;
  const src = index.text;
  let t = '';
  const map = []; // loose 偏移 → 原 text 偏移
  let lastSpace = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (/\s/.test(c)) {
      if (!lastSpace) { t += ' '; map.push(i); lastSpace = true; }
      continue;
    }
    lastSpace = false;
    t += c.toLowerCase();
    map.push(i);
  }
  return (index._loose = { text: t, map });
}
