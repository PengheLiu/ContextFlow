// 原位批注编辑器。
//
// 与右侧栏不各存一份状态：每次输入先交给 App 的共享草稿，再由 App 镜像到另一处；
// 500ms 停顿或失焦时才持久化，避免每个按键都写 localStorage / IDB / 服务端。
import { T, FLOAT, shadowHost } from './theme.js';
import { brandMark, icon } from './icons.js';
import { RichComposer, RICH_COMPOSER_CSS } from './rich-composer.js';

const CSS = `${FLOAT}${RICH_COMPOSER_CSS}
  .card{display:none;flex-direction:column;width:min(430px,calc(100vw - 24px));padding:0 0 12px;
        overflow:hidden;border-radius:7px;background-color:${T.paper};
        background-image:radial-gradient(circle at 1px 1px,var(--cf-grain) .65px,transparent .75px);background-size:5px 5px}
  .card::before{content:'';position:absolute;top:0;left:17px;width:42px;height:2px;background:${T.accent}}
  .card.on{display:flex}
  .hd{display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:9px 9px 8px 14px;
      border-bottom:1px solid ${T.line};background:${T.paper}}
  .hd-lock{display:flex;align-items:center;gap:9px;min-width:0}
  .hd-seal{width:28px;height:28px;display:grid;place-items:center;flex:0 0 auto;border:1px solid ${T.lineStrong};
      border-radius:4px;background:${T.paperRaised};color:${T.inkSoft}}
  .hd-seal .mk{width:17px;height:17px}
  .hd-copy{display:flex;flex-direction:column;gap:1px;min-width:0}
  .hd-copy b{font-size:13.5px;line-height:1.2;font-weight:700;letter-spacing:-.01em;color:${T.ink}}
  .hd-copy small{font-size:12px;line-height:1.25;font-weight:650;letter-spacing:.06em;color:${T.quote}}
  .x{all:unset;box-sizing:border-box;cursor:pointer;width:30px;height:30px;border-radius:6px;
     display:grid;place-items:center;color:${T.quote};transition:background .14s ease,color .14s ease}
  .x .ico{width:16px;height:16px}.x:hover{background:${T.hover};color:${T.ink}}
  .x:focus-visible{outline:2px solid ${T.focusLine};outline-offset:1px}

  .source{margin:15px 16px 0;padding:0 0 0 12px;border-left:2px solid ${T.accent}}
  .eyebrow{font:680 12px/1.3 ${T.sans};letter-spacing:.07em;color:${T.quote}}
  .src{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
       padding-top:6px;font:italic 14px/1.62 ${T.serif};color:${T.quote};overflow-wrap:anywhere}
  .edit{padding:14px 16px 0}
  .edit label{display:block;margin-bottom:6px;font-size:12px;font-weight:680;letter-spacing:.07em;color:${T.quote}}
  .edit .rc{max-height:min(39vh,330px);padding:8px 10px;border:1px solid ${T.line};border-radius:6px;
       background:${T.paperRaised};overflow-y:auto;transition:border-color .14s ease,box-shadow .14s ease}
  .edit .rc:focus-within{border-color:${T.focusLine};background:${T.paper};box-shadow:0 0 0 3px ${T.focusRing}}
  .edit .rc-figure{margin-left:0;margin-right:0}.edit .rc-media img{max-height:190px}
  .ft{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px 0}
  .state{display:inline-flex;align-items:center;gap:5px;min-width:0;color:${T.quote};font-size:12px}
  .state .ico{width:14px;height:14px;color:${T.accent}}
  .state.saved{color:${T.ok}}.state.saved .ico{color:${T.ok}}
  .state.bad{color:${T.bad}}.state.bad .ico{color:${T.bad}}
  .done{min-height:34px;display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border:1px solid ${T.accent};
        border-radius:6px;background:${T.accent};color:${T.paperRaised};font-size:13px;font-weight:680;white-space:nowrap}
  .done:hover{background:${T.accent};color:${T.paperRaised};filter:saturate(1.08) brightness(.94)}
  .done .ico{width:14px;height:14px}
  @media (max-width:420px){
    .hd-copy small{display:none}.source{margin-left:14px;margin-right:14px}.edit{padding-left:14px;padding-right:14px}
    .ft{padding-left:14px;padding-right:14px}.state{max-width:220px}
  }
`;

export class CommentPopover {
  /** @param {{onInput?:function,onCommit?:function,onClose?:function}} o */
  constructor(o = {}) {
    this.o = o;
    const sh = shadowHost('tip-comment', CSS, 2147483647);
    sh.innerHTML += `<section class="card" id="c" aria-label="原位批注编辑器">
      <div class="hd">
        <span class="hd-lock"><span class="hd-seal">${brandMark()}</span>
          <span class="hd-copy"><b>批注</b><small>与右侧栏同步</small></span></span>
        <button class="x" id="x" type="button" title="收起" aria-label="收起批注编辑器">${icon('close')}</button>
      </div>
      <section class="source"><div class="eyebrow">引用原文</div><div class="src" id="src"></div></section>
      <div class="edit"><label>你的想法</label><div id="q"></div></div>
      <div class="ft"><span class="state" id="state" role="status">${icon('sync')}<span>与右侧栏实时同步</span></span>
        <button class="done" id="done" type="button">${icon('check')}<span>完成</span></button></div>
    </section>`;
    this.sh = sh;
    this.$ = (id) => sh.getElementById(id);
    this.el = this.$('c');
    this.composer = new RichComposer(this.$('q'), {
      placeholder: '写下你的想法…', debounce: 500,
      onInput: (value) => {
        this.dirty = true;
        try {
          this.o.onInput?.(this.id, value);
          this.status('已同步到右侧栏', 'saved');
        } catch (e) {
          this.status(`同步失败：${e?.message || e}`, 'bad');
        }
      },
      onCommit: () => this.commit(),
      onAsset: (file) => this.o.onAsset?.(file),
      resolveAsset: (id) => this.o.resolveAsset?.(id),
    });
    Object.defineProperty(this, 'input', { get: () => this.composer.list.querySelector('.rc-text') });
    this.$('x').onclick = () => this.close();
    this.$('done').onclick = () => { this.commit(); this.close(false); };

    this.$('q').addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault(); this.$('done').click();
      } else if (e.key === 'Escape') {
        e.preventDefault(); this.close();
      }
    });

    document.addEventListener('click', (e) => {
      if (performance.now() - (this.openedAt ?? 0) < 400) return;
      if (!e.target?.closest?.('[data-contextflow]')) this.close();
    });
  }

  /** @param {DOMRect|object} rect @param {{id:string,source?:string,value?:string}} data */
  open(rect, data) {
    // 极端情况下用户没关上一条就用键盘重新划选：先提交旧草稿，不能因复用组件丢字。
    if (this.open$ && this.id && this.id !== data.id) {
      const previous = this.id;
      this.commit();
      clearTimeout(this.saveTimer);
      this.o.onClose?.(previous);
    }
    this.id = data.id;
    this.$('src').textContent = data.source ? `「${data.source}」` : '';
    this.composer.setValue(String(data.value ?? ''), true);
    this.dirty = false;
    this.status('与右侧栏实时同步');
    this.el.classList.add('on');
    this.openedAt = performance.now();
    this.grow();
    this.place(rect);
    setTimeout(() => this.input.focus(), 0);
    return this;
  }

  /** 侧栏输入时反向镜像；只接受当前正在编辑的高亮。 */
  setValue(id, value) {
    if (!this.open$ || id !== this.id) return this;
    this.composer.setValue(String(value ?? ''));
    this.dirty = false;             // 侧栏自己负责它那一侧的 500ms 持久化
    this.status('已同步侧栏修改', 'saved');
    return this;
  }

  markSaved(id) {
    if (this.open$ && id === this.id) this.status('已保存并同步', 'saved');
    return this;
  }

  status(text, cls = '') {
    const el = this.$('state');
    el.className = `state${cls ? ` ${cls}` : ''}`;
    el.querySelector('span').textContent = text;
  }

  commit() {
    clearTimeout(this.saveTimer);
    if (!this.dirty || !this.id) return;
    try {
      this.o.onCommit?.(this.id, this.composer.value());
      this.dirty = false;
      this.status('已保存并同步', 'saved');
    } catch (e) {
      this.status(`保存失败：${e?.message || e}`, 'bad');
    }
  }

  grow() {
    for (const ta of this.composer.list.querySelectorAll('.rc-text')) {
      ta.style.height = 'auto'; ta.style.height = `${Math.max(28, ta.scrollHeight + 1)}px`;
    }
  }

  place(rect) {
    const box = this.el.getBoundingClientRect();
    const w = box.width || 430, h = box.height || 260;
    const center = (rect?.left ?? 8) + (rect?.width ?? 0) / 2;
    const left = Math.min(Math.max(8, center - w / 2), Math.max(8, innerWidth - w - 8));
    const below = (rect?.bottom ?? 0) + 10;
    const top = below + h > innerHeight ? Math.max(8, (rect?.top ?? 0) - h - 10) : below;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(Math.min(top, Math.max(8, innerHeight - h - 8)))}px`;
  }

  close(commit = true) {
    if (!this.open$) return;
    if (commit) this.commit();
    clearTimeout(this.saveTimer);
    const id = this.id;
    this.el.classList.remove('on');
    this.o.onClose?.(id);
  }

  get open$() { return !!this.el?.classList.contains('on'); }
}
