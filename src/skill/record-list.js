import { groupRecords, matchesRecord, RECORD_FILTERS, recordKind } from '../core/reading-records.js';
import { icon } from './icons.js';
import { RichComposer } from './rich-composer.js';
import { renderMarkdownInto } from './markdown-view.js';
import { T } from './theme.js';

export const RECORD_CSS = `
  [hidden]{display:none!important}
  .record-controls{position:sticky;top:0;z-index:2;background:${T.paper};padding:15px 0 12px;border-bottom:1px solid ${T.line}}
  .record-search{width:100%;font:inherit;padding:8px 10px;border:1px solid ${T.line};border-radius:6px;background:${T.paperRaised};color:${T.ink}}
  .record-search:focus{outline:2px solid ${T.focusLine};outline-offset:1px}
  .record-filters{display:flex;gap:4px;margin-top:10px;flex-wrap:wrap}
  .record-filters button{font-size:12px;padding:5px 8px;border:1px solid transparent;border-radius:5px;color:${T.quote}}
  .record-filters button[aria-pressed=true]{background:${T.accentWash};color:${T.accent};border-color:${T.line}}
  .record-count{margin:8px 0 0;color:${T.quote};font-size:11.5px}
  .source-group{padding:20px 0 5px;border-bottom:1px solid ${T.line}}
  .source-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:${T.quote};margin-bottom:7px}
  .source-head button{font:inherit;color:${T.accent};padding:3px 0}
  .source-group>.src{margin-bottom:3px;padding-left:10px;border-left:2px solid ${T.lineStrong};white-space:pre-wrap}
  .source-group>.src.clamped{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .quote-toggle{font-size:11.5px;color:${T.accent};padding:3px 0}
  .source-group .item{padding-top:14px;padding-bottom:14px;border-bottom:1px dashed ${T.lineSoft}}
  .source-group .item::before{top:17px;bottom:15px}
  .source-group .kind{display:inline-flex;align-items:center;gap:5px;letter-spacing:0}.source-group .kind .ico{width:14px;height:14px}
  .record-actions{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
  .record-actions button{padding:4px 7px;font-size:11.5px;color:${T.quote};border:1px solid ${T.line};border-radius:5px;display:inline-flex;align-items:center;gap:4px}
  .record-actions .ico{width:13px;height:13px}.record-actions button:hover{color:${T.accent};background:${T.hover}}
  .answer-preview{overflow-wrap:anywhere;margin-top:8px;color:${T.inkSoft};max-height:11em;overflow:hidden;
    mask-image:linear-gradient(#000 calc(100% - 1em),transparent)}
  .answer-details summary,.answer-history summary{cursor:pointer;font-size:12px;color:${T.accent};padding:6px 0;list-style-position:inside}
  .answer-details[open] summary{position:sticky;top:130px;background:${T.paper};z-index:1}
  .answer-history{margin-top:10px;padding-top:6px;border-top:1px dashed ${T.line}}
  .answer-history .revision{padding:8px 0;color:${T.quote};font-size:12px}
  .answer-history .revision time{display:block;margin-bottom:5px}
  .undo-notice{padding:9px 16px;background:${T.accentWash};color:${T.inkSoft};display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px}
  .undo-notice button{color:${T.accent};font-weight:650;white-space:nowrap;padding:5px 8px}
  @media(prefers-reduced-motion:reduce){.pane.on,.st .dot2,.brief.run .dot2,.badge.busy::after{animation:none!important}}
`;

const labels = { comments: '批注', explain: '解释', translate: '翻译' };
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = value => new Date(value || Date.now()).toLocaleString('zh-CN', { hour12: false });

// Clone a bounded semantic excerpt, keeping formulas atomic. textContent would
// expose the hidden TeX annotation and flatten fractions back into plain text.
function answerPreview(target, answer) {
  target.replaceChildren(); target.classList.add('md');
  const budget = { chars: 280, nodes: 80 };
  const clone = node => {
    if (budget.chars <= 0 || budget.nodes-- <= 0) return null;
    if (node.nodeType === 3) {
      const value = node.textContent.slice(0, budget.chars); budget.chars -= value.length;
      return document.createTextNode(value);
    }
    if (node.nodeType !== 1 || node.matches('.md-footnotes')) return null;
    if (node.matches('.md-math')) {
      budget.chars -= Math.min(80, node.querySelector('annotation')?.textContent.length || node.textContent.length);
      const math = node.cloneNode(true); math.removeAttribute('tabindex'); return math;
    }
    const copy = node.cloneNode(false); copy.removeAttribute('id');
    if (copy.matches('a,button,[tabindex]')) copy.tabIndex = -1;
    if (copy.matches('button')) copy.disabled = true;
    for (const child of node.childNodes) { const part = clone(child); if (part) copy.append(part); }
    return copy;
  };
  for (const child of [...answer.children].slice(0, 3)) { const part = clone(child); if (part) target.append(part); }
}

// Keyed views are deliberately retained across polling, filters and tab switches.
// Updating one job must not replace another record's textarea, selection or paste.
export class RecordList {
  constructor(panel, mount) {
    this.p = panel; this.h = panel.h; this.mount = mount;
    this.filter = 'all'; this.query = ''; this.groups = new Map(); this.views = new Map();
    mount.innerHTML = `<div class="record-controls"><input class="record-search" type="search" aria-label="搜索当前文章的阅读记录" placeholder="搜索原文、回答或自己的想法…"><div class="record-filters" role="group" aria-label="筛选记录类型">${RECORD_FILTERS.map(([key,label]) => `<button type="button" data-filter="${key}" aria-pressed="${key === 'all'}">${label} <span></span></button>`).join('')}</div><p class="record-count" role="status" aria-live="polite"></p></div><div class="record-groups"></div><div class="empty"><span class="empty-icon">${icon('comment')}</span><strong></strong><span></span></div>`;
    this.list = mount.querySelector('.record-groups');
    this.empty = mount.querySelector('.empty');
    this.search = mount.querySelector('input');
    this.search.oninput = () => { this.query = this.search.value; this.render(); };
    for (const button of mount.querySelectorAll('[data-filter]')) button.onclick = () => this.select(button.dataset.filter);
  }
  select(filter = 'all') { this.filter = filter; this.render(); }
  reveal(id) {
    this.filter = 'all'; this.query = ''; this.search.value = ''; this.render();
    return this.views.get(id)?.el;
  }
  render() {
    const items = [...this.h.getItems().map(item => ({ action: 'highlight', ...item })),
      ...this.h.getLookups('explain').map(item => ({ action: 'explain', ...item })),
      ...this.h.getLookups('translate').map(item => ({ action: 'translate', ...item }))];
    const groups = groupRecords(items, this.h.positionOf, this.h.isOrphan);
    const live = new Set(items.map(item => item.id));
    for (const [id, view] of this.views) if (!live.has(id)) {
      // A removed editor's delayed debounce must not recreate a deleted comment.
      clearTimeout(view.composer?.saveTimer); view.el.remove(); this.views.delete(id);
      this.p.composers.delete(id); this.p.lookupComposers.delete(id);
    }
    const keepGroups = new Set(); let visible = 0, cursor = this.list.firstElementChild;
    for (const [index, group] of groups.entries()) {
      keepGroups.add(group.key);
      let shell = this.groups.get(group.key);
      if (!shell) {
        shell = document.createElement('section'); shell.className = 'source-group';
        shell.innerHTML = '<div class="source-head"><span></span><button type="button"></button></div><div class="src clamped" tabindex="0" role="button" aria-label="回到这条记录的原文位置"></div><button class="quote-toggle" type="button" hidden>展开引文</button><div class="group-items"></div>';
        this.groups.set(group.key, shell);
        const quote = shell.querySelector('.src'), toggle = shell.querySelector('.quote-toggle');
        toggle.onclick = () => { const collapsed = quote.classList.toggle('clamped'); toggle.textContent = collapsed ? '展开引文' : '收起引文'; toggle.setAttribute('aria-expanded', String(!collapsed)); };
      }
      if (cursor !== shell) this.list.insertBefore(shell, cursor); else cursor = cursor.nextElementSibling;
      shell.querySelector('.source-head span').textContent = `原文 ${String(index + 1).padStart(2, '0')}`;
      const located = group.items.find(item => !this.h.isOrphan(item.id));
      const locate = () => { if (located) this.h.onLocate?.(located.id); };
      const jump = shell.querySelector('.source-head button');
      jump.textContent = located ? '回到原文 ↗' : '原文暂未定位'; jump.disabled = !located; jump.onclick = locate;
      const quote = shell.querySelector('.src');
      if (quote.textContent !== group.text) quote.textContent = group.text;
      quote.onclick = locate; quote.tabIndex = located ? 0 : -1;
      quote.setAttribute('aria-disabled', String(!located));
      quote.onkeydown = e => { if (['Enter',' '].includes(e.key)) { e.preventDefault(); locate(); } };
      shell.querySelector('.quote-toggle').hidden = group.text.length < 180;
      let groupVisible = false, child = shell.querySelector('.group-items').firstElementChild;
      for (const item of group.items) {
        let view = this.views.get(item.id);
        if (!view) { view = this.create(item); this.views.set(item.id, view); }
        if (child !== view.el) shell.querySelector('.group-items').insertBefore(view.el, child); else child = child.nextElementSibling;
        this.update(view, item);
        const match = matchesRecord(item, this.filter, this.query, this.h.commentOf?.(item.id));
        view.el.hidden = !match; if (match) { visible++; groupVisible = true; }
      }
      shell.hidden = !groupVisible;
    }
    for (const [key, shell] of this.groups) if (!keepGroups.has(key)) { shell.remove(); this.groups.delete(key); }
    for (const button of this.mount.querySelectorAll('[data-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === this.filter));
      button.querySelector('span').textContent = items.filter(it => matchesRecord(it, button.dataset.filter, this.query, this.h.commentOf?.(it.id))).length;
    }
    const count = `${visible} 条记录${this.query || this.filter !== 'all' ? ` / 共 ${items.length} 条` : ' · 按原文顺序'}`;
    const counter = this.mount.querySelector('.record-count'); if (counter.textContent !== count) counter.textContent = count;
    this.empty.hidden = visible > 0;
    this.empty.querySelector('strong').textContent = items.length ? '没有匹配的记录' : '把阅读变成自己的积累';
    this.empty.querySelector('span:last-child').textContent = items.length ? '试试其他关键词，或切换到「全部」。' : '划选正文，写批注、提问或翻译。所有记录都会留在这里。';
  }
  create(item) {
    const kind = recordKind(item), el = document.createElement('article');
    el.className = `item ${kind === 'comments' ? 'comment' : `k-${kind}`}`; el.dataset.id = item.id;
    el.innerHTML = `<div class="item-head"><span class="kind">${icon(kind === 'comments' ? 'comment' : kind)} ${labels[kind]}</span><span class="seq"></span></div><div class="q2" hidden></div><div class="record-actions"><button data-act="open" type="button">${kind === 'comments' ? '原位编辑' : kind === 'translate' ? '原位查看' : '原位查看 / 追问'}</button><button data-act="copy" type="button">${icon('copy')}复制回答</button><button data-act="retry" type="button">${icon('retry')}重新生成</button><button data-act="cancel" type="button" hidden>取消生成</button><button data-act="del" type="button">${icon('trash')}删除</button></div><div class="st" hidden><span class="status-text"></span></div><div class="answer-preview" hidden></div><details class="answer-details"><summary aria-label="展开或收起回答">展开完整回答</summary><div class="ans"></div></details><details class="answer-history" hidden><summary>之前的答案</summary><div></div></details><div class="supplement"><div class="supplement-label">${kind === 'comments' ? '我的批注' : '我的补充'}</div><div class="cmt supp-editor"></div></div>`;
    const view = { el, kind, item, value: Symbol('initial') };
    const details = el.querySelector('.answer-details');
    details.ontoggle = () => { el.querySelector('.answer-preview').hidden = !view.long || details.open; details.querySelector('summary').textContent = details.open ? '收起回答' : '展开完整回答'; };
    const act = (name, callback) => { el.querySelector(`[data-act=${name}]`).onclick = this.p.guard(() => callback(view.item)); };
    const open = el.querySelector('[data-act=open]');
    open.textContent = kind === 'comments' ? '原位编辑' : kind === 'translate' ? '原位查看' : '原位追问';
    open.setAttribute('aria-label', kind === 'explain' ? '原位查看并追问' : open.textContent);
    const copy = el.querySelector('[data-act=copy]'); copy.innerHTML = `${icon('copy')}复制`; copy.setAttribute('aria-label', '复制回答');
    const remove = el.querySelector('[data-act=del]'); remove.innerHTML = icon('trash'); remove.setAttribute('aria-label', '删除'); remove.title = '删除记录，可撤销';
    act('open', it => this.h.onOpenRecord?.(it.id));
    act('copy', async it => { await this.h.onCopyAnswer?.(it.value || ''); this.p.syncMsg('回答已复制', 'ok'); });
    act('retry', it => this.h.onRetryLookup?.(it.id));
    act('cancel', it => this.h.onCancelLookup?.(it.id));
    act('del', it => kind === 'comments' ? this.h.onDelete(it.id) : this.h.onDeleteLookup(it.id));
    if (kind !== 'translate') {
      const composer = new RichComposer(el.querySelector('.cmt'), {
        value: kind === 'comments' ? this.h.commentOf(item.id) : this.h.getLookupSupplement?.(item.id),
        placeholder: kind === 'comments' ? '写下你的想法…' : '补充理解，或粘贴截图…',
        onInput: value => kind === 'comments' ? this.h.onCommentInput?.(item.id, value) : this.h.onLookupSupplementInput?.(item.id, value),
        onCommit: value => kind === 'comments' ? this.h.onCommentChange?.(item.id, value) : this.h.onLookupSupplementChange?.(item.id, value),
        onAsset: file => this.h.onAsset?.(file), resolveAsset: id => this.h.resolveAsset?.(id),
      });
      view.composer = composer;
      (kind === 'comments' ? this.p.composers : this.p.lookupComposers).set(item.id, composer);
    } else el.querySelector('.supplement').hidden = true;
    return view;
  }
  update(view, item) {
    const { el, kind } = view; view.item = item;
    el.style.setProperty('--mark', this.h.colorOf?.(item.id) || T.accent);
    const orphan = this.h.isOrphan(item.id); el.dataset.orphan = String(orphan);
    const editing = kind === 'comments' && this.h.isCommentEditing?.(item.id);
    el.classList.toggle('editing', !!editing);
    const state = el.querySelector('.seq'); state.textContent = editing ? '原文旁编辑' : orphan ? '未定位' : '';
    const question = el.querySelector('.q2'); question.hidden = !item.extra?.question; question.textContent = item.extra?.question || '';
    const running = item.extra?.status === 'running';
    const error = ['error','deferred'].includes(item.extra?.status);
    const canceled = item.extra?.status === 'canceled';
    const status = el.querySelector('.st'); status.hidden = !(running || error || canceled);
    status.className = `st ${error ? 'err' : ''}`;
    const msg = running ? (item.extra?.progress || '正在生成…') : canceled ? '已取消，可重新生成' : (item.extra?.error || '暂时无法生成，请重试');
    if (status.firstElementChild.textContent !== msg) status.firstElementChild.textContent = msg;
    for (const action of ['copy', 'retry', 'cancel']) {
      const button = el.querySelector(`[data-act=${action}]`);
      button.hidden = kind === 'comments' || (action === 'cancel' ? !running || kind !== 'explain' : action === 'copy' ? !item.value : running);
    }
    if (view.value !== item.value) {
      view.value = item.value;
      view.long = String(item.value || '').length > 500 || String(item.value || '').split('\n').length > 10;
      const details = el.querySelector('.answer-details');
      details.hidden = !item.value; details.querySelector('summary').hidden = !view.long;
      details.open = !view.long;
      const answer = el.querySelector('.ans'); renderMarkdownInto(answer, item.value || '');
      const preview = el.querySelector('.answer-preview'); preview.hidden = !view.long;
      if (view.long) answerPreview(preview, answer); else preview.replaceChildren();
    }
    const history = item.extra?.history || [];
    const historyKey = JSON.stringify(history);
    if (view.history !== historyKey) {
      view.history = historyKey; const box = el.querySelector('.answer-history'); box.hidden = !history.length;
      const list = box.querySelector('div'); list.replaceChildren();
      for (const revision of [...history].reverse()) {
        const section = document.createElement('div'); section.className = 'revision';
        section.innerHTML = `<time>${safe(time(revision.at))}</time><div></div>`;
        renderMarkdownInto(section.lastElementChild, revision.value || ''); list.append(section);
      }
    }
    if (view.composer && !view.composer.blocks.some(block => block.pending)) {
      const value = kind === 'comments' ? this.h.commentOf(item.id) : this.h.getLookupSupplement?.(item.id);
      // Mirrored local drafts are already reflected by onInput. A stale sync must
      // not replace the focused editor before its debounced commit completes.
      if (!view.composer.mount.contains(this.p.sh.activeElement)) view.composer.setValue(value || '');
    }
  }
}
