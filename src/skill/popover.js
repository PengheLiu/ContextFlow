// 划词查询浮层：翻译与解释共用。
//
// 两个必须保留的行为，都是踩过坑换来的：
//
// 1. 打开后 400ms 内忽略"外部点击"判定。工具条按钮走 mousedown 打开浮层，
//    紧接着的 mouseup 会在 document 上触发一次 click —— 若不忽略就会被当成
//    "点了外面"立刻关掉，表现为"必须一直按住才能看到浮层"。
// 2. 外部点击判定要放行**所有** [data-contextflow] 宿主，而不只是自己。
//    工具条是另一个 shadow host，只放行自己同样会误关。
import { T, FLOAT, shadowHost } from './theme.js';

const UI_KEY = 'contextflow:pop';
const MIN_W = 300, MIN_H = 200;

const loadUI = () => {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch { return {}; }
};
const saveUI = (ui) => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* 配额 */ } };

const CSS = `${FLOAT}
  /* flex 列布局：给定高度后，答案区滚动、输入区固定在底部。
     原来是 block + 各自写死 max-height，浮层一旦被拉高，多出来的空间没人用。 */
  /* padding-bottom 放在 card 上，而不是让每个子元素各自写 —— 无论最后一个可见的
     是输入框、答案还是元信息行，底部都有同样的留白。原先只有 .ask 的 padding
     写成 8px 12px 0，答案区为空时输入框就直接贴着卡片下沿。 */
  .card{display:none;flex-direction:column;padding:0 0 11px;overflow:hidden;
        width:min(480px,calc(100vw - 24px));max-height:calc(100vh - 24px)}
  .card.on{display:flex}
  /* 带输入框的（解释）默认给足高度：原来高度自适应，答案没出来之前只有两行，
     又扁又难输入。答案区在输入框下方，这块空间正好是「答案将出现在这里」。 */
  .card.has-input{min-height:340px}
  .hd{display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;
      padding:6px 7px 6px 12px;border-bottom:1px solid ${T.lineSoft};background:${T.sunk};
      cursor:move;user-select:none}
  .hd b{font-size:11px;font-weight:600;letter-spacing:.08em;color:${T.inkSoft}}
  .hd .r{gap:2px}
  .x,.exp{all:unset;cursor:pointer;width:22px;height:22px;border-radius:6px;
     display:grid;place-items:center;color:${T.quote};font:15px/1 ${T.sans}}
  .exp{font-size:11px}
  .x:hover,.exp:hover{background:rgba(28,26,23,.08);color:${T.ink}}

  /* 引文默认收起 3 行，但**可点开** —— 原来是 overflow:hidden 直接截断，
     用户看到的是断在词中间的半句话，还不知道后面有内容。 */
  .src{flex:0 0 auto;padding:8px 12px 0;font:italic 12px/1.55 ${T.serif};color:${T.quote};
       cursor:zoom-in;position:relative}
  .src.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  /* 只有 clipped 才提示。原先这个 ::after 是无条件的，引文只有一行、
     根本没被截断时也显示"点击展开" —— 那是在撒谎。 */
  .src.clip.clipped::after{content:'⋯ 点击展开';position:absolute;right:12px;bottom:0;
       background:${T.paper};padding-left:6px;font-style:normal;font-size:11px;color:${T.accent}}
  .src:not(.clipped){cursor:default}
  .src.open{cursor:zoom-out;max-height:40vh;overflow-y:auto}

  .ask{display:flex;gap:6px;align-items:flex-end;flex:0 0 auto;padding:8px 12px 0}
  .ask textarea{flex:1;border:1px solid ${T.line};border-radius:7px;background:${T.paper};
      color:${T.ink};font:13px/1.5 ${T.sans};padding:6px 8px;outline:none;
      resize:none;min-height:32px;overflow-y:auto}
  .ask textarea:focus{border-color:#d7cfbe;box-shadow:0 0 0 3px rgba(180,83,9,.07)}
  .ask button{border:1px solid ${T.line};background:${T.sunk};padding:6px 11px;
      font-size:12.5px;font-weight:600;white-space:nowrap}
  .ask button:hover{background:#ece7dd}
  #again{flex:0 0 auto;padding:2px 12px 0}
  #again button{border:1px solid ${T.line};background:${T.sunk};padding:4px 9px;font-size:11.5px}
  #again button:hover{background:#ece7dd}

  /* 答案区吃掉剩余空间。min-height:0 是 flex 子项能真正滚动的前提 */
  #b{flex:1 1 auto;min-height:0;padding:10px 12px 0;line-height:1.62;
     white-space:pre-wrap;overflow-y:auto;overflow-wrap:anywhere}
  /* 不再 display:none —— 它要负责撑起剩余空间。空态给一句灰字，
     否则一大片空白看起来像坏了 */
  #b:empty::before{content:'答案会显示在这里';color:#c3bdb0;font-size:12px}
  #b.prog{color:${T.quote};font-variant-numeric:tabular-nums}
  #f{flex:0 0 auto;padding:6px 12px 0;font-size:11px;color:${T.quote};
     font-variant-numeric:tabular-nums}
  #f:empty{display:none}

  /* 右下角拖拽把手。不用 CSS resize：它要求 overflow 非 hidden，
     而这里必须 hidden 才能保住圆角。 */
  .rz{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
  .rz::after{content:'';position:absolute;right:3px;bottom:3px;width:7px;height:7px;
     border-right:2px solid ${T.line};border-bottom:2px solid ${T.line}}
`;

export class Popover {
  /**
   * @param {object} o
   * @param {string} o.name      shadow host 标识（也用于 CSS 隔离）
   * @param {string} o.title     标题栏文字
   * @param {boolean} [o.input]  是否带输入框
   * @param {function} [o.onSubmit] 输入框提交回调 (question) => void
   */
  constructor(o) {
    this.o = o;
    const sh = shadowHost(o.name, CSS, 2147483647);
    sh.innerHTML += `<div class="card${o.input ? ' has-input' : ''}" id="c">
      <div class="hd" id="hd"><b>${o.title}</b><span class="r">
        <button class="exp" id="exp" title="展开 / 收起原文">⤢</button>
        <button class="x" id="x" title="关闭">×</button>
      </span></div>
      <div class="src" id="src"></div>
      ${o.input ? `<div class="ask">
        <textarea id="q" rows="1" placeholder="${o.placeholder || ''}"></textarea>
        <button id="go">${o.submitLabel || '提问'}</button>
      </div>` : ''}
      <div id="b"></div>
      <div id="again" style="display:none"><button id="re">重新解释</button></div>
      <div id="f"></div>
      <div class="rz" id="rz" title="拖动调整大小"></div>
    </div>`;
    this.sh = sh;
    this.$ = (id) => sh.getElementById(id);
    this.el = this.$('c');
    this.ui = loadUI();
    this.$('x').onclick = () => this.close();
    this.$('exp').onclick = () => this.toggleSrc();
    this.$('src').onclick = () => this.toggleSrc();
    this.wireDrag();
    this.wireResize();
    this.$('re').onclick = () => {
      this.showRefresh(false);
      this.o.onRefresh?.(this.question());
    };

    if (o.input) {
      const q = this.$('q');
      const submit = () => {
        const v = q.value.trim();
        // onSubmit 多是 async：不接住 reject 就只剩一条 unhandledrejection，
        // 界面上什么都不显示，看起来就是卡死
        try {
          const r = this.o.onSubmit?.(v);
          if (r && typeof r.catch === 'function') {
            r.catch((e) => this.body(`出错了：${e?.message || e}`, 'bad'));
          }
        } catch (e) { this.body(`出错了：${e?.message || e}`, 'bad'); }
      };
      this.$('go').onclick = submit;
      q.addEventListener('input', () => this.growInput());
      q.addEventListener('keydown', (e) => {
        // Enter 提交，Shift+Enter 换行 —— 这是输入框的通用预期
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
        if (e.key === 'Escape') this.close();
      });
    }

    document.addEventListener('click', (e) => {
      if (performance.now() - (this.openedAt ?? 0) < 400) return;   // 同一手势的收尾 click
      if (!e.target?.closest?.('[data-contextflow]')) this.close();
    });
  }

  /** @param {DOMRect} rect 选区位置  @param {string} [source] 顶部灰色引文 */
  open(rect, source = '') {
    const src = this.$('src');
    src.textContent = source ? `「${source}」` : '';
    // 每次打开都先收起：上一次展开过的状态带到新选区上会很怪
    src.className = source ? 'src clip' : 'src';

    this.el.classList.add('on');
    // 量一次是否真的被截断。必须在 .on 之后 —— 元素还没显示时 scrollHeight 是 0。
    if (source) src.classList.toggle('clipped', src.scrollHeight > src.clientHeight + 1);
    this.openedAt = performance.now();

    // 用户调过大小就沿用，没调过用默认宽 + 自适应高
    const { w, h } = this.ui;
    if (w) this.el.style.width = `${w}px`;
    if (h) this.el.style.height = `${h}px`;

    this.place(rect);
    return this;
  }

  /**
   * 定位：优先贴在选区下方，下方不够就翻到上方；再夹进视口。
   * 夹一次是必须的 —— 浮层现在可以被拉得很大，不夹住就会有一半在屏幕外，
   * 而它没有滚动条可言（fixed 定位）。
   */
  place(rect) {
    const r = this.el.getBoundingClientRect();
    const w = r.width || 460;
    const h = r.height || 260;
    let left = this.ui.x ?? Math.max(8, rect?.left ?? 8);
    let top;
    if (this.ui.y != null) {
      top = this.ui.y;
    } else {
      const below = (rect?.bottom ?? 0) + 10;
      top = below + h > innerHeight ? Math.max(8, (rect?.top ?? 0) - h - 10) : below;
    }
    this.el.style.left = `${Math.min(Math.max(8, left), Math.max(8, innerWidth - w - 8))}px`;
    this.el.style.top = `${Math.min(Math.max(8, top), Math.max(8, innerHeight - h - 8))}px`;
  }

  /** 引文展开 / 收起。默认收起 3 行，但要让人知道后面还有内容（见 .src.clip::after） */
  toggleSrc() {
    const el = this.$('src');
    if (!el.textContent) return;
    const open = el.classList.contains('open');
    // 没溢出就没有可展开的东西，切换只会让布局无谓跳一下
    if (!open && !el.classList.contains('clipped')) return;
    el.className = `src ${open ? 'clip clipped' : 'open'}`;
  }

  /** 拖标题栏移动。位置记进 localStorage —— 每次都回到选区旁边反而烦人 */
  wireDrag() {
    const hd = this.$('hd');
    hd.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;      // 标题栏上的按钮不触发拖动
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        const x = Math.min(Math.max(0, ev.clientX - dx), Math.max(0, innerWidth - r.width));
        const y = Math.min(Math.max(0, ev.clientY - dy), Math.max(0, innerHeight - 40));
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        this.ui = { ...this.ui, x, y };
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        saveUI(this.ui);
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  }

  /** 拖右下角缩放 */
  wireResize() {
    this.$('rz').addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = this.el.getBoundingClientRect();
      const move = (ev) => {
        const w = Math.max(MIN_W, Math.min(ev.clientX - r.left, innerWidth - r.left - 8));
        const h = Math.max(MIN_H, Math.min(ev.clientY - r.top, innerHeight - r.top - 8));
        this.el.style.width = `${w}px`;
        this.el.style.height = `${h}px`;
        this.ui = { ...this.ui, w, h };
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        saveUI(this.ui);
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  }

  body(text, cls = '') { const b = this.$('b'); b.textContent = text; b.className = cls; return this; }
  /** 命中本地缓存时才露出「重新解释」—— 平时不该占位置 */
  showRefresh(on) { const el = this.$('again'); if (el) el.style.display = on ? 'block' : 'none'; return this; }
  foot(text) { this.$('f').textContent = text; return this; }
  question() { return this.o.input ? this.$('q').value.trim() : ''; }

  /**
   * 输入框随内容长高，上限取浮层高度的一半 —— 原来写死 120px，
   * 浮层拉大了输入框也还是那么小，长问题只能在一条缝里滚。
   */
  growInput() {
    const q = this.$('q');
    if (!q) return;
    const cap = Math.max(80, Math.round((this.el.getBoundingClientRect().height || 260) * 0.5));
    q.style.height = 'auto';
    q.style.height = `${Math.min(q.scrollHeight + 2, cap)}px`;
  }

  focus() {
    if (!this.o.input) return this;
    const q = this.$('q');
    q.value = ''; q.style.height = 'auto';
    setTimeout(() => q.focus(), 0);
    return this;
  }

  close() { this.el?.classList.remove('on'); }
  get open$() { return !!this.el?.classList.contains('on'); }
}

/**
 * 跑秒进度：短请求也有 2~3 秒，没有反馈会让人以为没响应。
 * label 可中途改写 —— 本地 agent 一次要几十秒，中间要能报"排队中""正在读笔记库"，
 * 否则一个不动的秒表和卡死没有区别。
 */
export function ticker(pop, label = '思考中') {
  const t0 = performance.now();
  let cur = label;
  const write = () => pop.body(`${cur}… ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'prog');
  write();
  const id = setInterval(write, 100);
  return {
    label: (text) => { if (text) { cur = text; write(); } },
    stop: () => { clearInterval(id); return (performance.now() - t0).toFixed(0); },
  };
}
