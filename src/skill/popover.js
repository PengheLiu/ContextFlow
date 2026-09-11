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
import { brandMark, icon } from './icons.js';
import { MARKDOWN_CSS, renderMarkdownInto } from './markdown-view.js';
import { RichComposer, RICH_COMPOSER_CSS } from './rich-composer.js';

const UI_KEY = 'contextflow:pop';
const MIN_W = 300, MIN_H = 200;

const loadUI = () => {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch { return {}; }
};
const saveUI = (ui) => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* 配额 */ } };

const CSS = `${FLOAT}
  .card{display:none;flex-direction:column;padding:0 0 11px;overflow:hidden;
        width:min(500px,calc(100vw - 24px));max-height:calc(100vh - 24px);border-radius:7px;
        background-color:${T.paper};
        background-image:radial-gradient(circle at 1px 1px,var(--cf-grain) .65px,transparent .75px);background-size:5px 5px}
  .card::before{content:'';position:absolute;top:0;left:17px;width:42px;height:2px;background:${T.accent}}
  .card.on{display:flex}
  .card.has-input{min-height:380px}
  .hd{display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;
      min-height:54px;padding:9px 9px 9px 14px;border-bottom:1px solid ${T.line};
      background:${T.paper};cursor:move;user-select:none}
  .hd-lock{display:flex;align-items:center;gap:9px;min-width:0}
  .hd-seal{width:28px;height:28px;display:grid;place-items:center;border:1px solid ${T.lineStrong};
      border-radius:4px;background:${T.paperRaised};color:${T.inkSoft}}
  .hd-seal .mk{width:17px;height:17px}
  .hd-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
  .hd-copy b{font-size:13.5px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:${T.ink}}
  .hd-copy small{font-size:12px;line-height:1.25;font-weight:650;letter-spacing:.085em;color:${T.quote}}
  .hd .r{gap:1px}
  .x,.exp{all:unset;box-sizing:border-box;cursor:pointer;width:30px;height:30px;border-radius:6px;
     display:grid;place-items:center;color:${T.quote};transition:background .14s ease,color .14s ease}
  .x .ico,.exp .ico{width:16px;height:16px}
  .x:hover,.exp:hover{background:${T.hover};color:${T.ink}}
  .x:focus-visible,.exp:focus-visible{outline:2px solid ${T.focusLine};outline-offset:1px}

  .source{position:relative;flex:0 0 auto;margin:17px 17px 0;padding:0 28px 0 14px;border-left:2px solid ${T.accent}}
  .eyebrow{font:680 12px/1.3 ${T.sans};letter-spacing:.075em;color:${T.quote}}
  .src{padding:7px 0 0;font:italic 14px/1.7 ${T.serif};color:${T.quote};
       cursor:zoom-in;position:relative;overflow-wrap:anywhere}
  .src.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .src.clip.clipped::after{content:'继续阅读';position:absolute;right:0;bottom:0;
       background:linear-gradient(90deg,transparent 0,${T.paper} 28%);padding-left:26px;
       font:650 12px/1.7 ${T.sans};color:${T.accent}}
  .src:not(.clipped){cursor:default}.src.open{cursor:zoom-out;max-height:40vh;overflow-y:auto}
  .source .exp{position:absolute;right:-4px;top:-5px}

  .ask{display:grid;grid-template-columns:1fr auto;gap:7px;align-items:end;flex:0 0 auto;padding:17px 17px 0}
  .ask-field{min-width:0}
  .ask label{display:block;margin-bottom:6px;font-size:12px;font-weight:680;letter-spacing:.075em;color:${T.quote}}
  .ask textarea{display:block;width:100%;border:1px solid ${T.line};border-radius:6px;background:${T.paperRaised};
      color:${T.ink};font:13.5px/1.55 ${T.sans};padding:8px 10px;outline:none;resize:none;min-height:38px;
      overflow-y:auto;transition:border-color .14s ease,box-shadow .14s ease,background .14s ease}
  .ask textarea::placeholder{color:${T.placeholder}}
  .ask textarea:hover{border-color:${T.lineStrong}}
  .ask textarea:focus{border-color:${T.focusLine};background:${T.paper};box-shadow:0 0 0 3px ${T.focusRing}}
  .ask button{min-height:38px;display:inline-flex;align-items:center;gap:6px;border:1px solid ${T.accent};
      border-radius:6px;background:${T.accent};color:${T.paperRaised};padding:7px 12px;font-size:13px;font-weight:680;white-space:nowrap}
  .ask button:hover{background:${T.accent};border-color:${T.accent};color:${T.paperRaised};filter:saturate(1.08) brightness(.94)}
  .ask button .ico{width:14px;height:14px}

  .response{display:flex;min-height:0;flex:1 1 auto;flex-direction:column;margin:18px 17px 0;padding-top:14px;border-top:1px solid ${T.line}}
  .response .eyebrow{display:flex;align-items:center;gap:6px;flex:0 0 auto;color:${T.inkSoft}}
  .response .eyebrow .ico{width:14px;height:14px;color:${T.accent}}
  #b{flex:1 1 auto;min-height:0;padding:8px 0 4px;font-size:13.5px;line-height:1.72;
     white-space:pre-wrap;overflow-y:auto;overflow-wrap:anywhere}
  #b.md{white-space:normal}
  #b:empty::before{content:'答案会显示在这里';color:${T.placeholder};font:italic 13px/1.7 ${T.serif}}
  #b.prog{color:${T.quote};font-variant-numeric:tabular-nums}
  #again{flex:0 0 auto;padding:5px 0 0}
  #again button{display:inline-flex;align-items:center;gap:5px;border:1px solid ${T.line};
      background:transparent;padding:4px 8px;font-size:12px}
  #again button:hover{background:${T.hover};border-color:${T.lineStrong}}
  #again .ico{width:14px;height:14px}
  .supp{display:none;flex:0 0 auto;margin:12px 17px 0;padding-top:11px;border-top:1px dashed ${T.line}}
  .supp.on{display:block}.supp .eyebrow{margin-bottom:5px}
  .supp .rc{max-height:min(30vh,250px);padding:7px 9px;border:1px solid ${T.line};border-radius:6px;
       background:${T.paperRaised};overflow-y:auto;transition:border-color .14s ease,box-shadow .14s ease}
  .supp .rc:focus-within{border-color:${T.focusLine};background:${T.paper};box-shadow:0 0 0 3px ${T.focusRing}}
  .supp .rc-media img{max-height:170px}
  #f{flex:0 0 auto;margin:8px 17px 0;padding:9px 0 1px;border-top:1px solid ${T.lineSoft};
     font-size:12px;color:${T.quote};font-variant-numeric:tabular-nums}
  #f:empty{display:none}

  .rz{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize}
  .rz::after{content:'';position:absolute;right:5px;bottom:5px;width:7px;height:7px;
     border-right:1.5px solid ${T.lineStrong};border-bottom:1.5px solid ${T.lineStrong}}
  @media (max-width:420px){
    .source,.response{margin-left:14px;margin-right:14px}.ask{padding-left:14px;padding-right:14px}
    .hd-copy small{display:none}.ask{grid-template-columns:1fr}.ask button{justify-self:end}
  }
${MARKDOWN_CSS}
${RICH_COMPOSER_CSS}
`;

export class Popover {
  /**
   * @param {object} o
   * @param {string} o.name      shadow host 标识（也用于 CSS 隔离）
   * @param {string} o.title     标题栏文字
   * @param {boolean} [o.input]  是否带输入框
   * @param {boolean} [o.showSource=true] 是否显示引用原文
   * @param {function} [o.onSubmit] 输入框提交回调 (question) => void
   * @param {boolean} [o.supplement] 是否提供与解释记录绑定的“我的补充”图文编辑区
   */
  constructor(o) {
    this.o = o;
    const sh = shadowHost(o.name, CSS, 2147483647);
    const modeIcon = o.name.includes('translate') ? 'translate' : 'explain';
    const sourceSection = o.showSource === false ? '' : `<section class="source">
      <div class="eyebrow">引用原文</div><div class="src" id="src"></div>
      <button class="exp" id="exp" type="button" title="展开原文" aria-label="展开原文">${icon('expand')}</button>
    </section>`;
    sh.innerHTML += `<div class="card${o.input ? ' has-input' : ''}" id="c">
      <div class="hd" id="hd">
        <span class="hd-lock"><span class="hd-seal">${brandMark()}</span>
          <span class="hd-copy"><b>${o.title}</b><small>CONTEXT NOTE</small></span></span>
        <span class="r"><button class="x" id="x" type="button" title="关闭" aria-label="关闭">${icon('close')}</button></span>
      </div>
      ${sourceSection}
      ${o.input ? `<div class="ask"><div class="ask-field"><label for="q">追问</label>
        <textarea id="q" rows="1" placeholder="${o.placeholder || ''}"></textarea></div>
        <button id="go">${icon('send')}<span>${o.submitLabel || '提问'}</span></button>
      </div>` : ''}
      <section class="response"><div class="eyebrow">${icon(modeIcon)} ${o.title}结果</div><div id="b"></div>
        <div id="again" style="display:none"><button id="re" type="button">${icon('retry')}<span>重新解释</span></button></div></section>
      ${o.supplement ? '<section class="supp" id="supp"><div class="eyebrow">我的补充</div><div id="suppEditor"></div></section>' : ''}
      <div id="f"></div><div class="rz" id="rz" title="拖动调整大小"></div>
    </div>`;
    this.sh = sh;
    this.$ = (id) => sh.getElementById(id);
    this.el = this.$('c');
    this.ui = loadUI();
    this.$('x').onclick = () => this.close();
    if (this.$('exp')) this.$('exp').onclick = () => this.toggleSrc();
    if (this.$('src')) this.$('src').onclick = () => this.toggleSrc();
    this.wireDrag();
    this.wireResize();
    this.$('re').onclick = () => {
      this.showRefresh(false);
      this.o.onRefresh?.(this.question());
    };

    if (o.supplement) {
      this.supplementComposer = new RichComposer(this.$('suppEditor'), {
        placeholder: '补充文字，或把原文图片粘贴到这里…',
        onInput: (value) => this.supplementId
          && this.o.onSupplementInput?.(this.supplementId, value),
        onCommit: (value) => this.supplementId
          && this.o.onSupplementCommit?.(this.supplementId, value),
        onAsset: (file) => this.o.onAsset?.(file),
        resolveAsset: (id) => this.o.resolveAsset?.(id),
      });
    }

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
    this.anchorRect = rect;
    const src = this.$('src');
    if (src) {
      src.textContent = source ? `「${source}」` : '';
      // 每次打开都先收起：上一次展开过的状态带到新选区上会很怪
      src.className = source ? 'src clip' : 'src';
      this.setExpandState(false, !!source);
    }

    this.el.classList.add('on');
    // 量一次是否真的被截断。必须在 .on 之后 —— 元素还没显示时 scrollHeight 是 0。
    if (source && src) src.classList.toggle('clipped', src.scrollHeight > src.clientHeight + 1);
    this.openedAt = performance.now();

    // 用户调过大小就沿用，没调过用默认宽 + 自适应高
    const { w, h } = this.ui;
    if (w) this.el.style.width = `${w}px`;
    if (h) this.el.style.height = `${h}px`;

    this.place(rect);
    return this;
  }

  /** 答案或图文补充改变高度后，重新把浮层夹回视口。 */
  reposition() {
    clearTimeout(this.placeTimer);
    this.placeTimer = setTimeout(() => {
      if (this.open$) this.place(this.anchorRect);
    }, 0);
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
    if (!el?.textContent) return;
    const open = el.classList.contains('open');
    // 没溢出就没有可展开的东西，切换只会让布局无谓跳一下
    if (!open && !el.classList.contains('clipped')) return;
    el.className = `src ${open ? 'clip clipped' : 'open'}`;
    this.setExpandState(!open, true);
  }

  setExpandState(open, enabled = true) {
    const btn = this.$('exp');
    if (!btn) return;
    btn.innerHTML = icon(open ? 'collapse' : 'expand');
    btn.title = open ? '收起原文' : '展开原文';
    btn.setAttribute('aria-label', btn.title);
    btn.disabled = !enabled;
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

  /** 进度、错误和异常必须按纯文本显示，绝不解释其中的 Markdown / HTML。 */
  body(text, cls = '') {
    const b = this.$('b'); b.replaceChildren(document.createTextNode(text || '')); b.className = cls;
    return this.reposition();
  }
  /** 只有成功答案走安全 Markdown 预览；原始字符串仍由调用方原样持久化。 */
  answer(text) { const b = this.$('b'); b.className = ''; renderMarkdownInto(b, text); return this.reposition(); }
  /** 命中本地缓存时才露出「重新解释」—— 平时不该占位置 */
  showRefresh(on) { const el = this.$('again'); if (el) el.style.display = on ? 'block' : 'none'; return this; }
  /** 解释记录存在后才显示补充区；记录 id 用来与右侧栏绑定同一份内容。 */
  supplement(id, value = '') {
    if (!this.supplementComposer) return this;
    if (this.supplementId && this.supplementId !== id) this.supplementComposer.commit();
    this.supplementId = id || null;
    this.$('supp').classList.toggle('on', !!id);
    this.supplementComposer.setValue(String(value ?? ''), true);
    return this.reposition();
  }
  /** 右侧栏输入时只镜像内容，不触发本侧 onInput，避免回环。 */
  setSupplementValue(id, value) {
    if (this.supplementId === id) this.supplementComposer?.setValue(String(value ?? ''));
    return this.reposition();
  }
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

  focus(value = '') {
    if (!this.o.input) return this;
    const q = this.$('q');
    q.value = String(value ?? '');
    q.style.height = 'auto';
    this.growInput();
    setTimeout(() => q.focus(), 0);
    return this;
  }

  close() {
    if (this.open$ && this.supplementId) this.supplementComposer?.commit();
    this.el?.classList.remove('on');
  }
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
