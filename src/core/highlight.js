// 高亮渲染：CSS Custom Highlight API，零 DOM 侵入。
// 已在 arxiv.org/html/ 实页确认 CSS.highlights 可用（Chromium 105+）。
//
// 代价：高亮不是真实 DOM 节点，拿不到 click 事件 —— 用 caretPositionFromPoint
// 做命中测试补上（见 hitTest）。换来的好处是绝不改动页面 DOM，
// 不会被 React/Vue 的 re-render 冲掉，也不触发页面自身的 MutationObserver。

export const COLORS = {
  yellow: 'rgba(255, 214, 10, .45)',
  green: 'rgba(52, 199, 89, .35)',
  blue: 'rgba(10, 132, 255, .30)',
  pink: 'rgba(255, 55, 95, .30)',
};

// 暗色不是把日间颜色直接加深：在暖炭灰页面上降低亮度与透明度，
// 才不会像荧光笔发光。键与 COLORS 严格一致，工具条和正文可一一对应。
export const DARK_COLORS = {
  yellow: 'rgba(245, 194, 66, .32)',
  green: 'rgba(72, 175, 110, .30)',
  blue: 'rgba(80, 150, 235, .30)',
  pink: 'rgba(224, 94, 133, .29)',
};

// 查询标记：解释 / 翻译在原文留下的痕迹，点它可跳到右侧对应条目。
// 刻意不并进 COLORS —— 工具条的色板按钮是 Object.keys(COLORS) 生成的，
// 混进去会凭空多出两个可选"颜色"。
//
// 用下划线而不是背景填充：高亮已经占了"背景色"这个视觉语汇，查询标记叠在
// 同一段文字上时才不会糊成一团；实线/虚线的区别也比两种相近底色更好认。
// tint 刻意做到**自身可见**：我没能查实 Chromium 的 ::highlight() 是否接受
// text-decoration（查文档时一直被限流）。若不接受，只靠下划线就等于没有标记，
// 用户根本不知道那里可点。所以底色单独也能看出来，同时仍明显弱于高亮的
// .30~.45，叠在一起时不会喧宾夺主。
export const MARKS = {
  explain: {
    line: 'dotted', color: 'rgba(180, 83, 9, .95)', tint: 'rgba(180, 83, 9, .14)',
    darkColor: 'rgba(226, 160, 93, .96)', darkTint: 'rgba(226, 160, 93, .13)',
  },
  translate: {
    line: 'dashed', color: 'rgba(37, 99, 235, .9)', tint: 'rgba(37, 99, 235, .12)',
    darkColor: 'rgba(126, 173, 239, .96)', darkTint: 'rgba(126, 173, 239, .13)',
  },
};

/**
 * 「进行中」标记：提交解释的那一刻就画在原文上。
 *
 * 这样用户不必守在浮层前等 —— 本地 agent 一次几十秒，原地等是最糟的交互。
 * 关掉浮层去继续读，回头点这个标记就能看到进度或结果。
 * 样式刻意与 explain 同色系但更浅、线更细，一眼能分出"还没回来"。
 */
export const PENDING_MARK = {
  line: 'dotted', color: 'rgba(180, 83, 9, .5)', tint: 'rgba(180, 83, 9, .07)',
  darkColor: 'rgba(226, 160, 93, .62)', darkTint: 'rgba(226, 160, 93, .075)',
};

// 定位闪烁用的临时色，不出现在调色板里
const FLASH = 'rgba(180, 83, 9, .42)';
const DARK_FLASH = 'rgba(226, 160, 93, .34)';

// 所有标记样式（含 pending）。MARKS 只放"由 action 派生"的那些，
// 因为 main.js 要用 Object.keys(MARKS) 判断哪些 action 需要画标记。
const ALL_MARKS = { ...MARKS, pending: PENDING_MARK };

/** 样式名 → CSS highlight 通道名。标记加 mark- 前缀，避免与颜色重名。 */
const chan = (style) => (ALL_MARKS[style] ? `mark-${style}` : (COLORS[style] ? style : 'yellow'));

// 所有通道名，render/clear 按这个全集增删。
// 顺序有讲究：CSS.highlights 里后注册的优先级更高，背景会盖在先注册的之上。
// 标记放前面，高亮的背景色才压得住标记那层极淡的 tint；而高亮不设
// text-decoration，标记的下划线仍然照画 —— 两者叠在同一段文字上都看得见。
const CHANNELS = [...Object.keys(ALL_MARKS).map((m) => `mark-${m}`), ...Object.keys(COLORS)];

export function supported() {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
}

export class Highlighter {
  constructor() {
    this.items = new Map(); // id -> {range, color}
    this._styled = false;
    this._dark = null;      // 三态：null = 页面明暗未知，退回系统偏好
    this._styleEl = null;
  }

  /**
   * 标记色板跟谁走：面板 UI 按页面实测背景判定明暗（theme.js 的 pageTheme），
   * 系统 prefers-color-scheme 只是页面无法判定时的兜底。标记画在页面正文里，
   * 必须与 UI 用同一判定源 —— 否则「OS 浅色 + 网页深色」时 UI 是夜间纸、
   * 标记却还是日间色板。skill 载体启动后会订阅页面明暗并调用这里。
   * @param {boolean|null} dark 页面实测明暗；null = 未知
   */
  setDark(dark) {
    if (this._dark === dark) return;
    this._dark = dark;
    if (this._styleEl) this._styleEl.textContent = this._styleText();
  }

  _styleText() {
    const rules = (colors, dark = false) => [
      ...Object.entries(colors).map(([name, bg]) =>
        `::highlight(contextflow-${name}){background:${bg};color:inherit;}`),
      // tint 是给不认 text-decoration 的实现留的兜底：即使下划线没画出来，
      // 也还看得出这段被查过，不至于完全无标记。
      ...Object.entries(ALL_MARKS).map(([name, m]) =>
        `::highlight(contextflow-mark-${name}){color:inherit;background:${dark ? m.darkTint : m.tint};`
        + `text-decoration:underline ${m.line};text-decoration-color:${dark ? m.darkColor : m.color};`
        + `text-decoration-thickness:2px;text-underline-offset:2px;}`),
      `::highlight(contextflow-flash){background:${dark ? DARK_FLASH : FLASH};color:inherit;}`,
    ].join('\n');
    // 页面明暗已知时直接用对应色板；未知（扩展载体 / 无 watcher 的环境）退回媒体查询。
    if (this._dark === true) return rules(DARK_COLORS, true);
    if (this._dark === false) return rules(COLORS);
    return `${rules(COLORS)}\n@media (prefers-color-scheme:dark){\n${rules(DARK_COLORS, true)}\n}`;
  }

  _ensureStyles() {
    if (this._styled) return;
    const style = document.createElement('style');
    style.setAttribute('data-contextflow', 'styles');
    style.textContent = this._styleText();
    document.head.appendChild(style);
    this._styleEl = style;
    this._styled = true;
  }

  /** @param {string} style 颜色名（yellow…）或标记名（explain / translate） */
  set(id, range, style = 'yellow') {
    this.items.set(id, { range, channel: chan(style) });
  }

  delete(id) { this.items.delete(id); }

  clear() {
    this.items.clear();
    // 与 supported() 同一套判定：不支持 CSS Custom Highlight 的环境本来就没画过，
    // 停用时的"清场"（main.js stop()）在这里不该因此炸掉
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    for (const name of CHANNELS) CSS.highlights.delete(`contextflow-${name}`);
  }

  /** 按通道分组重建 Highlight 对象。每次增删后调用一次即可。 */
  render() {
    this._ensureStyles();
    const byChannel = new Map();
    for (const { range, channel } of this.items.values()) {
      let arr = byChannel.get(channel);
      if (!arr) byChannel.set(channel, arr = []);
      arr.push(range);
    }
    for (const name of CHANNELS) {
      const ranges = byChannel.get(name);
      if (ranges && ranges.length) {
        CSS.highlights.set(`contextflow-${name}`, new Highlight(...ranges));
      } else {
        CSS.highlights.delete(`contextflow-${name}`);
      }
    }
  }

  /** 视口坐标 → 命中的高亮 id。重叠时返回最短的那个（最具体）。 */
  hitTest(x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node) return null;

    let hitId = null, hitLen = Infinity;
    for (const [id, { range }] of this.items) {
      let inside = false;
      try { inside = range.isPointInRange(node, offset); } catch { /* 跨文档等异常，忽略 */ }
      if (!inside) continue;
      const len = String(range).length;
      if (len < hitLen) { hitLen = len; hitId = id; }
    }
    return hitId;
  }

  /** 从面板跳转过来时短暂加深，帮眼睛找到位置 */
  flash(id, ms = 1100) {
    const it = this.items.get(id);
    if (!it) return;
    this._ensureStyles();
    CSS.highlights.set('contextflow-flash', new Highlight(it.range));
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => CSS.highlights.delete('contextflow-flash'), ms);
  }

  /** 已解析出 Range 的 id 集合 —— 未出现的即为失锚 */
  has(id) { return this.items.has(id); }

  /** 用于面板 → 原文的滚动定位：返回整个 Range 的 union rect */
  rectOf(id) {
    const it = this.items.get(id);
    if (!it) return null;
    try {
      const r = it.range.getBoundingClientRect();
      return r && (r.width || r.height) ? r : null;
    } catch { return null; }
  }

  /**
   * 用于原文上的删除按钮：返回选区**最后一个视觉片段**。
   *
   * 多行 Range 的 getBoundingClientRect() 是所有行的 union，right/top 并不代表
   * 选区结尾；按钮会飘到第一行以外很远。getClientRects() 按绘制顺序给出各碎片，
   * 最后一个非空 rect 才是「区域结尾的右上角」。
   */
  endRectOf(id) {
    const it = this.items.get(id);
    if (!it) return null;
    try {
      // Array.from 而不是展开语法：旧一些的 Chromium 里 DOMRectList 有 length/item
      // 但不一定声明 Symbol.iterator；扩展 minimum_chrome_version=111 要兼容这种形状。
      const rects = Array.from(it.range.getClientRects()).filter((r) => r.width || r.height);
      return rects.at(-1) ?? this.rectOf(id);
    } catch { return null; }
  }
}
