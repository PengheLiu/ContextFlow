// 小型图文块编辑器。继续以 Markdown 字符串作为事件载荷，因此旧数据无需迁移；
// 图片在 UI 中是原子块，在字符串中是 contextflow-asset 引用。
import { T } from './theme.js';
import { assetToken, joinAssetDocument, splitAssetDocument } from '../core/assets.js';
import { icon } from './icons.js';

export const RICH_COMPOSER_CSS = `
  .rc{min-width:0}.rc-blocks{display:flex;flex-direction:column;min-width:0}
  .rc-text{display:block;width:100%;min-height:1.7em;padding:2px 0 4px;border:0;border-bottom:1px solid transparent;
    outline:none;resize:none;overflow:hidden;background:transparent;color:${T.ink};font:13.5px/1.68 ${T.sans};overflow-wrap:anywhere}
  .rc-text::placeholder{color:${T.placeholder}}.rc-text:focus{border-bottom-color:${T.accent}}
  .rc-figure{position:relative;margin:9px 0 10px;border:1px solid ${T.line};border-radius:7px;overflow:hidden;background:${T.paperRaised}}
  .rc-media{min-height:82px;display:grid;place-items:center;background:${T.sunk};color:${T.quote};font-size:12px}
  .rc-media img{display:block;width:100%;max-height:310px;object-fit:contain;background:${T.sunk}}
  .rc-media .ico{width:18px;height:18px;color:${T.accent}}
  .rc-figure.bad .rc-media{color:${T.bad}}
  .rc-caption{display:block;width:100%;padding:7px 36px 8px 9px;border:0;border-top:1px solid ${T.line};outline:none;
    background:${T.paperRaised};color:${T.inkSoft};font:12.5px/1.45 ${T.sans}}
  .rc-caption::placeholder{color:${T.placeholder}}.rc-caption:focus{box-shadow:inset 0 0 0 2px ${T.focusRing}}
  .rc-remove{position:absolute;right:6px;bottom:5px;width:27px;height:27px;padding:0;display:grid;place-items:center;
    border-radius:5px;background:${T.paperRaised};color:${T.quote}}
  .rc-remove:hover{background:${T.hover};color:${T.bad}}.rc-remove .ico{width:14px;height:14px}
  .rc-hint{display:flex;align-items:center;gap:5px;margin-top:5px;color:${T.quote};font-size:11.5px}
  .rc-hint .ico{width:13px;height:13px}.rc.busy .rc-hint{color:${T.accent}}
  .rc.drag{outline:2px solid ${T.focusLine};outline-offset:4px;border-radius:4px}
`;

const grow = (ta) => {
  ta.style.height = 'auto';
  ta.style.height = `${Math.max(28, ta.scrollHeight + 1)}px`;
};

const imageFromTransfer = (dt) => {
  for (const item of dt?.items || []) {
    if (item.kind === 'file' && item.type?.startsWith('image/')) return item.getAsFile();
  }
  for (const file of dt?.files || []) if (file.type?.startsWith('image/')) return file;
  return null;
};

export class RichComposer {
  /** @param {HTMLElement} mount @param {{value?:string,placeholder?:string,onInput?:function,onCommit?:function,onAsset?:function,resolveAsset?:function}} o */
  constructor(mount, o = {}) {
    this.o = o;
    this.mount = mount;
    mount.classList.add('rc');
    mount.innerHTML = `<div class="rc-blocks"></div><div class="rc-hint">${icon('image')}<span>可粘贴截图或图片</span></div>`;
    this.list = mount.querySelector('.rc-blocks');
    this.hint = mount.querySelector('.rc-hint span');
    this.blocks = [];
    this.dirty = false;
    this.setValue(o.value || '', true);

    mount.addEventListener('dragover', (e) => {
      if (!imageFromTransfer(e.dataTransfer)) return;
      e.preventDefault(); mount.classList.add('drag');
    });
    mount.addEventListener('dragleave', () => mount.classList.remove('drag'));
    mount.addEventListener('drop', (e) => {
      const file = imageFromTransfer(e.dataTransfer);
      mount.classList.remove('drag');
      if (!file) return;
      e.preventDefault();
      const last = [...this.list.querySelectorAll('.rc-text')].at(-1);
      this.insertImage(this.blocks.length - 1, last?.value?.length || 0, last?.value?.length || 0, file);
    });
  }

  value() { return joinAssetDocument(this.blocks.filter((b) => !b.pending)); }

  setValue(value, force = false) {
    value = String(value || '');
    if (!force && value === this.value()) return this;
    clearTimeout(this.saveTimer);
    this.blocks = splitAssetDocument(value);
    this.dirty = false;
    this.render();
    return this;
  }

  render() {
    this.list.replaceChildren();
    this.blocks.forEach((block, index) => {
      if (block.type === 'image') this.renderImage(block, index);
      else this.renderText(block, index);
    });
    return this;
  }

  renderText(block, index) {
    const ta = document.createElement('textarea');
    ta.className = 'rc-text'; ta.rows = 1; ta.value = block.value || '';
    ta.dataset.blockIndex = String(index);
    ta.placeholder = this.blocks.length === 1 ? (this.o.placeholder || '') : '';
    ta.addEventListener('input', () => { block.value = ta.value; grow(ta); this.emit(); });
    ta.addEventListener('blur', () => this.commit());
    ta.addEventListener('paste', (e) => {
      const file = imageFromTransfer(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      this.insertImage(index, ta.selectionStart, ta.selectionEnd, file);
    });
    this.list.append(ta); grow(ta);
  }

  renderImage(block, index) {
    const fig = document.createElement('figure');
    fig.className = `rc-figure${block.error ? ' bad' : ''}`;
    const media = document.createElement('div'); media.className = 'rc-media';
    if (block.error) media.textContent = block.error;
    else if (block.pending) media.innerHTML = `${icon('sync')}<span>正在保存图片…</span>`;
    else {
      const img = document.createElement('img'); img.alt = block.alt || '图片';
      media.append(img);
      Promise.resolve(this.o.resolveAsset?.(block.id)).then((url) => {
        if (url && img.isConnected) img.src = url;
        else if (img.isConnected) media.textContent = '图片暂不可用';
      }).catch(() => { if (img.isConnected) media.textContent = '图片加载失败'; });
    }
    const caption = document.createElement('input');
    caption.className = 'rc-caption'; caption.value = block.alt || '';
    caption.placeholder = '添加图片说明'; caption.disabled = !!block.pending;
    caption.addEventListener('input', () => { block.alt = caption.value; this.emit(); });
    caption.addEventListener('blur', () => this.commit());
    const remove = document.createElement('button'); remove.className = 'rc-remove'; remove.type = 'button';
    remove.title = '删除图片'; remove.setAttribute('aria-label', '删除图片'); remove.innerHTML = icon('trash');
    remove.onclick = () => { this.blocks.splice(index, 1); this.ensureTextBlock(index); this.render(); this.emit(true); };
    fig.append(media, caption, remove); this.list.append(fig);
  }

  ensureTextBlock(at = this.blocks.length) {
    if (!this.blocks.some((b) => b.type === 'text')) this.blocks.splice(at, 0, { type: 'text', value: '' });
  }

  async insertImage(index, start, end, file) {
    const block = this.blocks[index]?.type === 'text' ? this.blocks[index] : { type: 'text', value: '' };
    const value = String(block.value || '');
    const before = `${value.slice(0, start).replace(/[ \t]*$/, '')}\n\n`;
    const after = `\n\n${value.slice(end).replace(/^[ \t]*/, '')}`;
    const pending = { type: 'image', pending: true, alt: file.name?.replace(/\.[^.]+$/, '') || '截图' };
    this.blocks.splice(index, 1, { type: 'text', value: before }, pending, { type: 'text', value: after });
    this.render(); this.busy(true, '正在保存图片…');
    try {
      const asset = await this.o.onAsset?.(file);
      if (!asset?.id) throw new Error('图片保存未返回附件 id');
      pending.id = asset.id; pending.alt = asset.alt || pending.alt; pending.pending = false;
      this.render(); this.busy(false, '图片已保存，可继续粘贴'); this.emit(true);
      const next = this.list.querySelector(`.rc-text[data-block-index="${index + 2}"]`);
      next?.focus(); next?.setSelectionRange(2, 2);
    } catch (e) {
      pending.pending = false; pending.error = e?.message || String(e);
      this.render(); this.busy(false, '图片保存失败');
    }
  }

  busy(on, label) {
    this.mount.classList.toggle('busy', on);
    this.hint.textContent = label || (on ? '正在保存图片…' : '可粘贴截图或图片');
  }

  emit(commit = false) {
    const value = this.value();
    this.dirty = true;
    this.o.onInput?.(value);
    clearTimeout(this.saveTimer);
    if (commit) this.commit();
    else this.saveTimer = setTimeout(() => this.commit(), this.o.debounce ?? 600);
  }

  commit() {
    clearTimeout(this.saveTimer);
    if (!this.dirty) return;
    this.dirty = false;
    this.o.onCommit?.(this.value());
  }
  focus() { this.list.querySelector('.rc-text')?.focus(); return this; }
}
