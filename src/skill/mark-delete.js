// 原文标记的就地删除按钮。
//
// CSS Custom Highlight 不是 DOM 节点，拿不到自己的 click，也不能把按钮 append 到标记上。
// 所以这里只保留**一个** fixed-position Shadow DOM 按钮：点击某条标记时，根据 Range 的
// 最后一个 client rect 临时摆到视觉末端的右上角；点别处 / 滚动 / resize 就收起。
import { T, shadowHost } from './theme.js';

const CSS = `
  .x{all:unset;display:none;position:fixed;box-sizing:border-box;
     width:23px;height:23px;border-radius:50%;cursor:pointer;
     place-items:center;background:${T.paper};color:${T.quote};
     border:1px solid ${T.line};box-shadow:0 2px 10px rgba(28,26,23,.20);
     font:600 15px/1 ${T.sans};user-select:none}
  .x.on{display:grid}
  .x:hover{color:#b3261e;border-color:rgba(179,38,30,.30);background:#fff8f7}
  .x:focus-visible{outline:2px solid ${T.accent};outline-offset:2px}
  .sr{position:fixed;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);
      clip-path:inset(50%);white-space:nowrap}
`;

const SIZE = 23;
const GAP = 3;
const INSET = 8;

export class MarkDeleteControl {
  /** @param {(id:string)=>void} onDelete */
  constructor(onDelete) {
    const sh = shadowHost('mark-delete', CSS, 2147483647);
    sh.innerHTML += `<button class="x" id="x" type="button">×</button>
      <span class="sr" id="status" role="status" aria-live="polite"></span>`;
    this.sh = sh;
    this.el = sh.getElementById('x');
    this.status = sh.getElementById('status');
    this.onDelete = onDelete;
    this.openId = null;
    this.openedAt = 0;

    this.el.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = this.openId;
      if (!id) return;
      this.hide();
      this.onDelete?.(id);
      this.status.textContent = '记录已删除';
    };

    document.addEventListener('click', (e) => {
      if (!this.visible) return;
      if (performance.now() - this.openedAt < 400) return;  // 打开它的同一次 click
      if (e.target?.closest?.('[data-contextflow]')) return;
      this.hide();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });
    addEventListener('scroll', () => this.hide(), { passive: true });
    addEventListener('resize', () => this.hide(), { passive: true });
  }

  /**
   * @param {string} id
   * @param {DOMRect|object} rect Range 的最后一个视觉碎片
   * @param {string} label action 专属的无障碍文案
   */
  show(id, rect, label = '删除此记录') {
    if (!id || !rect) return this.hide();
    this.openId = id;
    this.openedAt = performance.now();
    this.el.title = label;
    this.el.setAttribute('aria-label', label);
    this.el.classList.add('on');

    // 默认摆在最后一片的右上角、略向外偏；右侧不够时翻到左边。
    const roomRight = rect.right + GAP + SIZE <= innerWidth - INSET;
    let left = roomRight ? rect.right + GAP : rect.left - GAP - SIZE;
    let top = rect.top - SIZE + 5;               // 右上角，略压住边缘但不遮文字
    left = Math.min(Math.max(INSET, left), Math.max(INSET, innerWidth - SIZE - INSET));
    top = Math.min(Math.max(INSET, top), Math.max(INSET, innerHeight - SIZE - INSET));
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  hide() {
    this.el?.classList.remove('on');
    this.openId = null;
  }

  get visible() { return !!this.el?.classList.contains('on'); }
}
