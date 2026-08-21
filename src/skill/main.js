// ContextFlow 载体入口：划词翻译 / 解释 / 高亮批注 / 全文总结。
//
// 数据流：localStorage 本地镜像（秒开 + 离线）→ 本地服务 SQLite（事实源）→ 笔记（按天汇总）。
//
// 翻译与解释都**存进**本地事件流（要在面板里回看、要在原文留标记），但只有解释
// 参与同步 —— 翻译是纯机器输出，混进笔记会污染喂给 Agent 的信噪比。
// "存" 与 "同步" 是两件事，别把它们合并成一个开关。
//
// UI 分工：右侧停靠面板承载 翻译 / 解释 / 批注 / 总结 四个 tab（panel.js）；
// 页面上只留一个划词工具条和查询浮层。高亮与查询标记都走 CSS Custom Highlight
// API，零 DOM 侵入；点标记跳面板、点面板条目跳原文，双向定位。
// 锚点解析的分层统计显示在面板底栏 —— 那是验证三层降级是否真在工作的唯一手段，别去掉。

import { buildTextIndex, serializeRange, resolveAnchor, charOffsetOf, boundaryOffset }
  from '../core/anchor.js';
import { Highlighter, COLORS, MARKS, supported } from '../core/highlight.js';
import * as api from '../core/api.js';
import { T, FLOAT, shadowHost } from './theme.js';
import { Panel } from './panel.js';
import { Popover, ticker } from './popover.js';
import { MarkDeleteControl } from './mark-delete.js';
import { lookupKey, lookupId } from '../core/lookupkey.js';
import { reconcile } from '../core/reconcile.js';

const MIRROR = 'contextflow:v2:';

// 会在原文留标记的 action。直接由 MARKS 派生，避免两处各写一份而走形。
const MARKED = new Set(Object.keys(MARKS));

export function urlKey(href = location.href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/);
    if (/(^|\.)arxiv\.org$/.test(u.hostname) && m) return `arxiv:${m[1]}`;
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|spm|from)/.test(p)) u.searchParams.delete(p);
    }
    u.hash = '';
    return (u.origin + u.pathname.replace(/\/+$/, '') + (u.search || '')).toLowerCase();
  } catch { return href; }
}

const mGet = (k) => { try { return JSON.parse(localStorage.getItem(MIRROR + k) || '[]'); } catch { return []; } };
const mSet = (k, v) => { try { localStorage.setItem(MIRROR + k, JSON.stringify(v)); } catch { /* 配额 */ } };

const TOOLBAR_CSS = `${FLOAT}
  .card{display:none;gap:3px;align-items:center}
  .sw{width:19px;height:19px;border-radius:50%;padding:0;
      border:1px solid rgba(28,26,23,.14);box-shadow:inset 0 -1px 2px rgba(0,0,0,.05)}
  .sw:hover{transform:scale(1.14)}
  .sep{width:1px;height:18px;background:${T.line};margin:0 3px}
  .txt{font-size:12.5px;padding:5px 8px}
`;

export class App {
  constructor() {
    this.key = urlKey();
    this.items = mGet(this.key);
    this.hl = new Highlighter();
    this.index = null;
    this.pos = new Map();          // id → 解析后的文档偏移，用于面板排序
    this.stats = { position: 0, quote: 0, fuzzy: 0, orphan: 0 };
    this.online = false;
    this.timer = null;
    // lookup id → 当前轮询的 AbortController。删除 pending 记录时用它中止轮询，
    // 也防止已经晚到的结果把已删除记录用稳定 id "复活"。
    this.lookupRuns = new Map();
  }

  async start() {
    if (!supported()) return console.error('[ContextFlow] 浏览器不支持 CSS Custom Highlight API');
    this.buildToolbar();
    this.markDelete = new MarkDeleteControl((id) => this.deleteMarked(id));
    this.panel = new Panel(this.handlers());
    this.reanchor();
    this.wire();
    await this.sync();
    this.resumePending();          // 接上刷新前没跑完的解释
    if (this.panel.open) this.autoSummarize();   // 面板记忆为展开：这也算"打开插件"
    console.log('[ContextFlow] 就绪', { key: this.key, n: this.items.length, online: this.online });
  }

  handlers() {
    return {
      getItems: () => this.items.filter((e) => e.action === 'highlight'),
      getStats: () => this.stats,
      getNote: () => this.noteItem()?.value ?? '',
      isOnline: () => this.online,
      outbox: () => api.outboxSize(),
      positionOf: (id) => this.pos.get(id) ?? Number.MAX_SAFE_INTEGER,
      isOrphan: (id) => !this.hl.has(id),
      colorOf: (id) => COLORS[this.items.find((e) => e.id === id)?.color] ?? COLORS.yellow,
      commentOf: (id) => this.commentFor(id)?.value ?? '',
      onCommentChange: (id, v) => this.saveComment(id, v),
      onNoteChange: (v) => this.saveNote(v),
      onDelete: (id) => this.deleteHighlight(id),
      onLocate: (id) => this.locate(id),
      api,
      onReanchor: () => this.reanchor(),
      // 只做筛选，排序统一交给 panel 的 byPosition（见 core/order.js）
      getLookups: (kind) => this.items.filter((e) => e.action === kind && !e.deletedAt),
      onDeleteLookup: (id) => this.deleteLookup(id),
      onOpen: () => this.autoSummarize(),
      onSummarize: (fresh) => this.autoSummarize(fresh),
      onRetryLookup: (id) => this.retryLookup(id),
      onSync: async () => {
        const r = await api.sync();
        await this.sync();          // 同步后回读，刷新「待同步」计数
        return r;
      },
    };
  }

  // ---------- 服务对账 ----------
  async sync() {
    try {
      await api.health();
      this.online = true;
      const flushed = await api.flushOutbox();
      if (flushed) console.log(`[ContextFlow] 补发 ${flushed} 条积压`);
      // 取数据前先记下本地都有哪些 id：await 期间用户可能又划了一条，
      // 那条服务端还没有，不能被当成"服务端已删"抹掉。
      const localBefore = new Set(this.items.map((e) => e.id));
      const remote = await api.fetchEvents(this.key);
      this.items = reconcile(this.items, remote,
        { pending: api.outboxSize(), localBefore });
      mSet(this.key, this.items);
      this.reanchor();
    } catch (e) {
      this.online = false;
      console.warn('[ContextFlow] 本地服务不可达，离线模式：', e.message);
    }
    this.panel.render();
  }

  /**
   * 把正文交给服务端，作为该文章连续对话的首条消息。
   *
   * **按需上传**，不在页面加载时做。原先是每次加载都传，结果库里堆了一堆
   * Google 搜索页、GitHub、Reddit 的全文 —— 那些页面用户一个字都没标注，
   * 正文却已经存进去了。既浪费，也存了用户没要求存的内容。
   * 现在只在真的要翻译/解释时才传。
   *
   * 直接复用 reanchor 建好的归一化索引 —— 那本来就是"整篇正文的纯文本"，
   * 没必要再写一套抽取逻辑（也不会和锚定用的文本口径不一致）。
   * 本地按内容指纹去重，所以重复调用只有第一次走网络；懒加载补齐后
   * 指纹会变，正文自然重传、对话重开。
   */
  async uploadArticle() {
    const text = this.index?.text;
    if (!text || text.length < 200) return;        // 太短的页面没有上下文价值
    if (this.articleHash === this.hashOf(text)) return;
    try {
      const r = await api.putArticle({
        urlKey: this.key, title: document.title, url: location.href, text,
      });
      this.articleHash = this.hashOf(text);
      if (r.changed) {
        console.log(`[ContextFlow] 已上传正文 ${r.chars} 字符${r.truncated ? '（已截断）' : ''}`);
      }
    } catch (e) {
      console.warn('[ContextFlow] 正文上传失败，翻译/解释将没有全文上下文：', e.message);
    }
  }

  /** 便宜的本地指纹，只用来避免重复上传，不参与服务端去重 */
  hashOf(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
    return `${s.length}:${h.toString(16)}`;
  }

  persist(events) {
    mSet(this.key, this.items);
    api.pushEvents(events).then((ok) => {
      if (ok !== this.online) { this.online = ok; this.panel.renderStatus(); }
    });
  }

  // ---------- 锚定 ----------
  reanchor() {
    this.markDelete?.hide();        // range 即将全部重建，旧坐标失效
    this.index = buildTextIndex(document.body);
    this.stats = { position: 0, quote: 0, fuzzy: 0, orphan: 0 };
    this.hl.items.clear();
    this.pos.clear();
    for (const it of this.items) {
      if (it.deletedAt || !it.anchor) continue;
      const isHl = it.action === 'highlight';
      // 解释 / 翻译也要在原文留标记，才能点原文跳回右侧条目
      if (!isHl && !MARKED.has(it.action)) continue;
      const res = resolveAnchor(it.anchor, this.index);
      if (res) {
        // 统计只算高亮：状态栏 ok/n 的分母是高亮条数，混入查询记录会出现 5/3 这种数
        if (isHl) this.stats[res.tier]++;
        // 还没拿到结果的画成 pending 样式（更浅），一眼能分出"在跑"与"已回来"
        this.hl.set(it.id, res.range,
          isHl ? (it.color || 'yellow') : (it.value ? it.action : 'pending'));
        // 用解析出的真实位置排序，而不是存下来的旧偏移 —— 页面改版后旧偏移会乱序
        this.pos.set(it.id, charOffsetOf(this.index, res.range.startContainer, res.range.startOffset)
          ?? it.anchor.start ?? 0);
      } else {
        if (isHl) this.stats.orphan++;
        this.pos.set(it.id, it.anchor.start ?? Number.MAX_SAFE_INTEGER);
      }
    }
    this.hl.render();
    this.panel?.render();
  }

  scheduleReanchor() { clearTimeout(this.timer); this.timer = setTimeout(() => this.reanchor(), 400); }

  noteItem() { return this.items.find((e) => e.action === 'note'); }
  commentFor(id) { return this.items.find((e) => e.action === 'comment' && e.parentId === id && !e.deletedAt); }

  locate(id) {
    const rect = this.hl.rectOf(id);
    if (!rect) return;
    scrollTo({ top: scrollY + rect.top - innerHeight * 0.35, behavior: 'smooth' });
    this.hl.flash(id);
  }

  // ---------- 划词工具条 ----------
  buildToolbar() {
    const sh = shadowHost('toolbar', TOOLBAR_CSS, 2147483647);
    sh.innerHTML += `<div class="card r" id="tb">
      ${Object.keys(COLORS).map((c) =>
        `<button class="sw" data-c="${c}" title="高亮" style="background:${COLORS[c]}"></button>`).join('')}
      <span class="sep"></span>
      <button class="txt" data-a="comment" title="高亮并在右侧写评论">批注</button>
      <button class="txt" data-a="explain" title="就这段内容提问">解释</button>
      <button class="txt" data-a="translate" title="翻译选中文本">翻译</button>
    </div>`;
    this.tb = sh.getElementById('tb');
    // mousedown + preventDefault：点击若走 click 事件，选区已被清掉
    this.tb.addEventListener('mousedown', (e) => {
      const b = e.target.closest?.('button');
      if (!b) return;
      e.preventDefault();
      const sel = getSelection();
      if (!sel || sel.isCollapsed) return;
      const range = sel.getRangeAt(0).cloneRange();
      if (b.dataset.c) this.addHighlight(range, b.dataset.c);
      else if (b.dataset.a === 'comment') this.addHighlight(range, 'yellow', true);
      else if (b.dataset.a === 'explain') this.doExplain(range);
      else this.doTranslate(range);
    });
  }

  wire() {
    document.addEventListener('mouseup', () => setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hideTb();
      const range = sel.getRangeAt(0);
      if (!String(range).trim()) return this.hideTb();
      const a = range.commonAncestorContainer;
      const el = a.nodeType === 1 ? a : a.parentElement;
      if (el?.closest?.('[data-contextflow]')) return this.hideTb();
      const r = range.getBoundingClientRect();
      this.tb.style.display = 'flex';
      this.tb.style.left = `${Math.min(Math.max(8, r.left), innerWidth - 250)}px`;
      this.tb.style.top = `${r.top > 54 ? r.top - 46 : r.bottom + 10}px`;
    }, 0));

    // 翻译面板是常驻的（由 × 或点击页面空白关闭），滚动只收工具条
    addEventListener('scroll', () => this.hideTb(), { passive: true });

    document.addEventListener('click', (e) => {
      if (e.target?.closest?.('[data-contextflow]')) return;
      if (!getSelection()?.isCollapsed) { this.markDelete?.hide(); return; }
      const id = this.hl.hitTest(e.clientX, e.clientY);
      if (!id) { this.markDelete?.hide(); return; }
      this.hl.flash(id, 600);
      // 命中的可能是高亮，也可能是解释/翻译标记 —— 后者得切到对应 tab，
      // 否则跳去批注 tab 而那里根本没有这一条，表现为"点了没反应"
      const it = this.items.find((x) => x.id === id);
      const act = it?.action;
      if (MARKED.has(act)) this.panel.focusLookup(act, id);
      else this.panel.focusItem(id);

      // 打开 push 模式面板会挤窄正文并触发换行；必须等下一帧再量最后一个视觉碎片，
      // 否则 × 会停在重排前的旧坐标。
      requestAnimationFrame(() => {
        if (!this.hl.has(id) || !this.items.some((x) => x.id === id)) return;
        const rect = this.hl.endRectOf(id);
        if (!rect) return this.markDelete?.hide();
        const label = act === 'highlight' ? '删除此高亮'
          : act === 'translate' ? '删除此翻译记录' : '删除此解释记录';
        this.markDelete?.show(id, rect, label);
      });
    });

    new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target, el = t.nodeType === 1 ? t : t.parentElement;
        if (el?.closest?.('[data-contextflow]')) continue;   // 忽略自己造成的变动
        return this.scheduleReanchor();
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  hideTb() { if (this.tb) this.tb.style.display = 'none'; }

  /**
   * 延后到当前手势结束再收工具条。
   * 工具条按钮走 mousedown（为保住选区），若在 mousedown 里同步隐藏按钮，
   * 松手时它已不在布局中，浏览器只能把 click 派发到指针下方的页面元素 ——
   * 于是任何「target 是否属于 [data-contextflow]」的判断都会误判成「点了外面」。
   */
  hideTbSoon() { setTimeout(() => this.hideTb(), 0); }

  // ---------- 高亮 / 评论 / 总结 ----------
  addHighlight(range, color, openComment = false) {
    // 必须用**新鲜**索引序列化。旧索引是 reanchor() 时建的，若期间 MathJax/懒加载
    // 改过文本节点内容，节点内偏移就整体错位，序列化出的 exact 会两端各差几个字符
    // （实测症状：'have increasingly evolved' 存成 'e increasingly evolve'）。
    this.index = buildTextIndex(document.body);
    const anchor = serializeRange(range, this.index);
    if (!anchor) return console.warn('[ContextFlow] 选区不在正文索引内，未记录');

    // 自检：开了词边界吸附后，引文**本就可能比选区长**（补齐了半个词），
    // 所以判据从"相等"改为"包含"。不包含才说明偏移映射有问题。
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const sel = norm(String(range));
    if (sel && !norm(anchor.exact).includes(sel)) {
      console.warn('[ContextFlow] 引文未包含选区，偏移映射可能有误\n'
        + `  选区: ${JSON.stringify(sel.slice(0, 80))}\n`
        + `  引文: ${JSON.stringify(norm(anchor.exact).slice(0, 80))}`);
    }
    const ev = {
      id: crypto.randomUUID(), urlKey: this.key, url: location.href,
      title: document.title, action: 'highlight', text: anchor.exact,
      value: null, color, anchor, parentId: null, createdAt: Date.now(),
    };
    this.items.push(ev);
    this.persist([ev]);
    getSelection()?.removeAllRanges();
    this.hideTbSoon();
    this.reanchor();
    if (openComment) this.panel.focusItem(ev.id);
  }

  saveComment(highlightId, raw) {
    const body = (raw ?? '').trim();
    const parent = this.items.find((e) => e.id === highlightId);
    let c = this.commentFor(highlightId);
    if (!c) {
      if (!body) return;
      c = {
        id: crypto.randomUUID(), urlKey: this.key, url: location.href,
        title: document.title, action: 'comment', text: parent?.text ?? null,
        value: body, color: null, anchor: parent?.anchor ?? null,
        parentId: highlightId, createdAt: Date.now(),
      };
      this.items.push(c);
    } else {
      if (c.value === body) return;                    // 无变化，不打扰服务端
      c.value = body;
      if (!body) c.deletedAt = Date.now();
    }
    this.persist([c]);
    if (c.deletedAt) this.items = this.items.filter((e) => e.id !== c.id);
  }

  /** 原文上的 × 统一分派到已有删除路径，不复制状态/API 逻辑 */
  deleteMarked(id) {
    const it = this.items.find((e) => e.id === id);
    if (!it) return;
    if (it.action === 'highlight') this.deleteHighlight(id);
    else if (MARKED.has(it.action)) this.deleteLookup(id);
  }

  deleteHighlight(id) {
    this.markDelete?.hide();
    const c = this.commentFor(id);
    this.items = this.items.filter((e) => e.id !== id && e.id !== c?.id);
    mSet(this.key, this.items);
    api.deleteEvent(id);
    if (c) api.deleteEvent(c.id);
    this.reanchor();
  }

  deleteLookup(id) {
    this.markDelete?.hide();
    const ev = this.items.find((e) => e.id === id);
    const jobId = ev?.extra?.jobId;
    // 中止浏览器侧的轮询；服务端作业也 best-effort 取消，别让已删除的问题继续耗额度
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.delete(id);
    if (jobId) api.cancelJob(jobId);
    this.items = this.items.filter((e) => e.id !== id);
    mSet(this.key, this.items);
    api.deleteEvent(id);
    if (this.watching === id) this.tipFor('explain').close();
    this.reanchor();          // 顺带抹掉原文上的标记
  }

  saveNote(body) {
    let n = this.noteItem();
    if (!n) {
      // id 由 urlKey 派生：同一篇文章的笔记始终 upsert 同一行，不会越写越多
      n = {
        id: `note:${this.key}`, urlKey: this.key, url: location.href,
        title: document.title, action: 'note', text: null, value: body,
        color: null, anchor: null, parentId: null, createdAt: Date.now(),
      };
      this.items.push(n);
    } else {
      if (n.value === body) return;
      n.value = body;
    }
    this.persist([n]);
    this.panel.renderStatus();
  }

  // ---------- 划词查询：翻译 / 解释 ----------

  /** 两个浮层惰性创建，避免未用到的功能也注入 DOM */
  tipFor(kind) {
    this.pops ??= {};
    if (this.pops[kind]) return this.pops[kind];
    return (this.pops[kind] = kind === 'translate'
      ? new Popover({ name: 'tip-translate', title: '翻译' })
      : new Popover({
        name: 'tip-explain', title: '解释', input: true,
        placeholder: '想问什么？留空则直接解释这段（Enter 提交）',
        submitLabel: '提问',
        onSubmit: (q) => this.runExplain(q),
        // 命中本地缓存后想要新答案，得有个明确的出口，否则只能改问题措辞
        onRefresh: (q) => this.runExplain(q, true),
      }));
  }

  /**
   * 在**选中的那一刻**就把锚点与偏移固定下来。
   *
   * 起因是一条真实记录：页面上第一次解释，anchor 存成了 null —— 原文没有标记、
   * 列表里也排到了最后（无锚点 → 排序回落到末尾）。原因是 doExplain 只克隆了
   * range，而序列化发生在用户打完问题、几秒之后；arxiv HTML 这类页面期间会重排
   * （MathJax / 懒加载），克隆的 range 早已失效，serializeRange 返回 null。
   *
   * 所以：趁 range 还活着立刻算完，之后只用算好的结果。
   */
  snapshot(range) {
    // 必须用新鲜索引 —— 理由同 addHighlight 的注释
    this.index = buildTextIndex(document.body);
    let anchor = null, offset;
    try { anchor = serializeRange(range, this.index); } catch { /* 选区不在索引内 */ }
    try {
      // 用 boundaryOffset 而不是 charOffsetOf：选区起点也可能是元素节点
      offset = boundaryOffset(this.index, range.startContainer, range.startOffset, 'start')
        ?? undefined;
    } catch { /* 同上 */ }
    if (offset === undefined && Number.isInteger(anchor?.start)) offset = anchor.start;
    if (!anchor) console.warn('[ContextFlow] 选区不在正文索引内，该条将没有原文标记');
    return { anchor, offset };
  }

  async doTranslate(range) {
    const text = String(range).trim();
    const { anchor, offset } = this.snapshot(range);
    const pop = this.tipFor('translate');
    this.hideTbSoon();
    pop.open(range.getBoundingClientRect()).foot('');
    const tk = ticker(pop, '翻译中');
    try {
      await this.uploadArticle();      // 按需：只为真正查过的页面存正文
      const { translation, cached, usage, model, truncated, target, ctx } =
        await api.translate(text, undefined, this.key, offset);
      if (target) this.target = target;
      const ms = tk.stop();
      pop.body(translation).foot(this.meta({ cached, usage, model, truncated, ms, ctx }));
      this.saveLookup('translate', { text, value: translation, anchor,
        extra: { target: this.target || '' } });
    } catch (e) {
      tk.stop();
      pop.body(`翻译失败：${e.message}`, 'bad').foot(this.hintFor(e));
    }
  }

  /** 解释分两步：先弹输入框拿补充问题，再请求。留空也可直接提交。 */
  doExplain(range) {
    const text = String(range).trim();
    // 锚点在这里就定下来，不留到提交时再算（那时 range 可能已失效）
    this.explainCtx = { text, rect: range.getBoundingClientRect(), ...this.snapshot(range) };
    this.hideTbSoon();
    const pop = this.tipFor('explain').open(this.explainCtx.rect, text)
      .body('').foot('').showRefresh(false);
    // 这一段之前问过 / 正在问，打开时就把状态摆出来，别让人以为什么都没发生
    const prev = this.items.find((e) => e.action === 'explain' && !e.deletedAt
      && lookupKey(e) === lookupKey({ action: 'explain', text, extra: { question: '' } }));
    if (prev?.value) pop.body(prev.value).foot('之前的回答 · 可直接提问覆盖').showRefresh(true);
    else if (prev && prev.extra?.status === 'running') pop.body('这段正在解释中…', 'prog');
    pop.focus();
  }

  async runExplain(question, fresh = false) {
    const pop = this.tipFor('explain');
    const ctx = this.explainCtx;
    // 静默 return 会表现成"点了提问毫无反应"，和卡死无从区分
    if (!ctx) {
      pop.body('选区已丢失，请重新划选后再提问。', 'bad').foot('');
      return;
    }
    await this.uploadArticle();        // 按需：只为真正查过的页面存正文
    const draft = { text: ctx.text, question, anchor: ctx.anchor, offset: ctx.offset };
    // 提交即落一条"进行中"记录：原文立刻有标记、面板立刻有条目。
    // 这样不必守着浮层等 —— agent 一次几十秒，原地等是最糟的交互。
    const { id, jobId } = this.beginLookup(draft);
    const tk = ticker(pop, '思考中');
    // 已经在跑就接上去看，别再提交一遍 —— 否则同一个问题会排两个作业
    if (jobId && !fresh) {
      tk.label('已在进行中，接着看…');
      await this.followJob(id, jobId, draft, { pop, tk });
      return;
    }
    await this.pollExplain(id, draft, { fresh, pop, tk });
  }

  /**
   * 落一条待完成的解释记录并返回它的 id。
   * value 留空 —— 服务端的 lookupHistory / findLookup / 同步渲染都要求 value 非空，
   * 所以半成品不会污染对话历史、不会被当成缓存命中、也不会被同步进笔记。
   */
  beginLookup({ text, question, anchor, offset }) {
    const seed = { action: 'explain', text, extra: { question: question || '' } };
    const prev = this.items.find((e) => e.action === 'explain' && !e.deletedAt
      && lookupKey(e) === lookupKey(seed));
    const id = prev?.id ?? lookupId(this.key, seed);
    const ev = {
      id, urlKey: this.key, url: location.href, title: document.title,
      action: 'explain', text, value: null, color: null,
      anchor: anchor ?? prev?.anchor ?? null, parentId: null,
      extra: { question: question || '', status: 'running', offset },
      createdAt: prev?.createdAt ?? Date.now(),
    };
    this.items = [...this.items.filter((e) => e.id !== id), ev];
    mSet(this.key, this.items);          // 只存本地：没结果的半成品不值得推给服务端
    this.reanchor();
    // 同一段同一问题若已有作业在跑，调用方应当**附着**上去而不是再提交一次
    const busy = prev && !prev.value && prev.extra?.status === 'running' && prev.extra?.jobId;
    return { id, jobId: busy ? prev.extra.jobId : null };
  }

  /** 更新某条查询记录的状态（进度 / 失败原因），只动本地镜像 */
  patchLookup(id, patch) {
    const ev = this.items.find((e) => e.id === id);
    if (!ev) return null;
    ev.extra = { ...ev.extra, ...patch };
    mSet(this.key, this.items);
    this.panel.render();
    return ev;
  }

  /**
   * 发起并跟进一次解释。
   * 浮层可以随时关掉 —— 结果回来时写进记录并刷新面板，不依赖浮层还在不在。
   */
  async pollExplain(id, draft, { fresh = false, pop = null, tk = null } = {}) {
    const live = () => pop && pop.open$ && this.watching === id;
    const ctl = new AbortController();
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.set(id, ctl);
    const alive = () => !ctl.signal.aborted && this.items.some((e) => e.id === id);
    this.watching = id;
    try {
      const r = await api.explain({
        text: draft.text, question: draft.question, urlKey: this.key,
        offset: draft.offset, fresh, signal: ctl.signal,
        onProgress: (job) => {
          if (!alive()) return;
          const note = job.queuedAhead
            ? `排队中（前面 ${job.queuedAhead} 个）`
            : (job.progress || '本地 agent 思考中');
          // 进度写进记录，面板上也能看到 —— 浮层关了照样有地方看
          this.patchLookup(id, { status: 'running', progress: note, jobId: job.id });
          if (live()) tk?.label(note);
        },
      });
      if (!alive()) { tk?.stop(); return; }       // 删除/abort 后，晚到结果不得复活记录
      const ms = tk?.stop() ?? 0;
      this.saveLookup('explain', {
        text: draft.text, value: r.answer, anchor: draft.anchor,
        extra: { question: r.question || draft.question || '' },
      });
      if (live()) {
        pop.body(r.answer).foot(this.meta({ ...r, ms })).showRefresh(r.cached === 'local');
      }
    } catch (e) {
      tk?.stop();
      if (ctl.signal.aborted || e.code === 'ABORTED' || !this.items.some((x) => x.id === id)) return;
      // 失败也留痕：条目上显示原因并给「重试」，而不是悄悄消失
      this.patchLookup(id, { status: 'error', error: e.message, progress: '' });
      if (live()) pop.body(`解释失败：${e.message}`, 'bad').foot(this.hintFor(e));
    } finally {
      if (this.lookupRuns.get(id) === ctl) this.lookupRuns.delete(id);
      if (this.watching === id) this.watching = null;
    }
  }

  /**
   * 跟进一个**已存在**的作业（重复点击、或页面刷新后接上）。
   * 与 pollExplain 的区别只有一个：不再 POST，避免为同一个问题排两个作业。
   */
  async followJob(id, jobId, draft, { pop = null, tk = null } = {}) {
    const live = () => pop && pop.open$ && this.watching === id;
    const ctl = new AbortController();
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.set(id, ctl);
    const alive = () => !ctl.signal.aborted && this.items.some((e) => e.id === id);
    this.watching = id;
    try {
      for (;;) {
        if (!alive()) return;
        const job = await api.getJob(jobId);
        if (!alive()) return;
        if (job.status === 'done') {
          const ms = tk?.stop() ?? 0;
          this.saveLookup('explain', {
            text: draft.text, value: job.result.answer, anchor: draft.anchor,
            extra: { question: draft.question || '' },
          });
          if (live()) pop.body(job.result.answer).foot(this.meta({ ...job.result, ms }));
          return;
        }
        if (job.status === 'error' || job.status === 'canceled') {
          throw Object.assign(new Error(job.error?.message || '作业已取消'), { code: job.error?.code });
        }
        const note = job.queuedAhead ? `排队中（前面 ${job.queuedAhead} 个）`
          : (job.progress || '本地 agent 思考中');
        this.patchLookup(id, { status: 'running', progress: note, jobId });
        if (live()) tk?.label(note);
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (e) {
      tk?.stop();
      if (ctl.signal.aborted || !this.items.some((x) => x.id === id)) return;
      this.patchLookup(id, { status: 'error', error: e.message, progress: '' });
      if (live()) pop.body(`解释失败：${e.message}`, 'bad').foot(this.hintFor(e));
    } finally {
      if (this.lookupRuns.get(id) === ctl) this.lookupRuns.delete(id);
      if (this.watching === id) this.watching = null;
    }
  }

  /**
   * 速览：打开面板时给一段全文概述，让人先知道这篇在讲什么。
   *
   * **每篇只做一次。** 结果落库（action='summary'，id 由 urlKey 派生），
   * 再打开同一篇直接读缓存。走 agent 时一次要几十秒且花钱，所以绝不能每次
   * 展开面板都重跑 —— this.briefBusy 挡住同一页内的重复触发，服务端的本地缓存
   * 挡住跨页面/跨会话的重复。
   *
   * @param {boolean} [fresh] 点「重新生成」时跳过缓存
   */
  async autoSummarize(fresh = false) {
    if (this.briefBusy) return;
    const has = this.items.find((e) => e.action === 'summary' && !e.deletedAt && e.value);
    if (has && !fresh) {
      this.panel.renderBrief({ state: 'ok', text: has.value, retry: true });
      return;
    }
    // 正文太短的页面不值得总结（搜索结果页、仓库首页、列表页）
    const text = this.index?.text || '';
    if (text.length < 1200) { this.panel.renderBrief(null); return; }

    this.briefBusy = true;
    const t0 = performance.now();
    this.panel.renderBrief({ state: 'run', text: '正在生成速览…' });
    try {
      await this.uploadArticle();
      const r = await api.summarize({
        urlKey: this.key, fresh,
        onProgress: (job) => this.panel.renderBrief({
          state: 'run',
          text: job.queuedAhead ? `排队中（前面 ${job.queuedAhead} 个）`
            : (job.progress || '正在生成速览…'),
        }),
      });
      const ms = (performance.now() - t0).toFixed(0);
      // 落库：速览要作为这条对话的第一轮，后面的解释才接得上
      this.saveLookup('summary', { text: '', value: r.summary, anchor: null, extra: {} });
      this.panel.renderBrief({
        state: 'ok', text: r.summary, retry: true,
        meta: [this.meta({ ...r, ms }), r.degraded].filter(Boolean).join(' · '),
      });
    } catch (e) {
      this.panel.renderBrief({
        state: 'err', retry: true,
        text: `速览失败：${e.message}`,
        meta: this.hintFor(e),
      });
    } finally {
      this.briefBusy = false;
    }
  }

  /** 面板上点「重试」 */
  retryLookup(id) {
    const ev = this.items.find((e) => e.id === id);
    if (!ev) return;
    this.patchLookup(id, { status: 'running', progress: '重新提交…', error: '' });
    this.pollExplain(id, {
      text: ev.text, question: ev.extra?.question || '',
      anchor: ev.anchor, offset: ev.extra?.offset,
    }, { fresh: true });
  }

  /**
   * 页面加载后接上未完成的解释。
   *
   * 作业只活在服务端内存里，页面一刷新轮询就断了。若不管，那条记录会永远显示
   * "进行中"。这里逐条查一次：还在跑就接着跟，已完成就写回结果，查不到就标成
   * 中断并给重试 —— 三种下场都比"永远转圈"好。
   */
  async resumePending() {
    const pend = this.items.filter((e) => e.action === 'explain' && !e.value && !e.deletedAt);
    for (const ev of pend) {
      const jobId = ev.extra?.jobId;
      if (!jobId) {
        this.patchLookup(ev.id, { status: 'error', error: '上次未完成（页面已刷新）', progress: '' });
        continue;
      }
      try {
        const job = await api.getJob(jobId);
        if (job.status === 'done' && job.result?.answer) {
          this.saveLookup('explain', {
            text: ev.text, value: job.result.answer, anchor: ev.anchor,
            extra: { question: ev.extra?.question || '' },
          });
        } else if (job.status === 'error') {
          this.patchLookup(ev.id, { status: 'error', error: job.error?.message || '作业失败' });
        } else {
          // 还在跑 —— 接上去继续跟，别重新提交
          this.followJob(ev.id, jobId, {
            text: ev.text, question: ev.extra?.question || '', anchor: ev.anchor,
          });
        }
      } catch {
        this.patchLookup(ev.id, { status: 'error', error: '作业已过期，可重试', progress: '' });
      }
    }
  }

  meta({ cached, usage, model, truncated, thinking, ms, ctx, via, agentMeta }) {
    // 'local' = 命中本地库里已有的答案（没打上游、没起 agent）
    if (cached === 'local') {
      const when = ctx?.cachedAt ? new Date(ctx.cachedAt).toLocaleString('zh-CN', { hour12: false }) : '';
      return `本地已有答案${when ? ` · ${when}` : ''} · ${ms}ms · 未计费`;
    }
    if (cached) return `缓存命中 · ${ms}ms · 未计费`;
    return [
      via?.startsWith('agent') ? `${model}（本地 agent）` : model,
      usage ? `${usage.in}→${usage.out} tok` : null,
      // 连续对话是否真的命中了缓存 —— 不显示出来就没人能验证"稳定命中 KV-Cache"
      usage?.cacheRead ? `cache ${usage.cacheRead}` : null,
      ctx?.hasArticle
        ? `正文 ${ctx.chunks ?? '?'}/${ctx.totalChunks ?? '?'} 段 · ${ctx.turns ?? 0} 轮`
        : (ctx ? '无正文上下文' : null),
      ctx?.truncated ? '⚠ 正文已截断' : null,
      // 不能续接的 agent 每次都要重发整段对话，这会直接反映在耗时上，
      // 与其让人纳闷"为什么不走缓存"，不如写清楚
      agentMeta && agentMeta.resumed === false ? '未续接会话（每次重发对话）' : null,
      ctx?.dropped ? `⚠ 已丢弃 ${ctx.dropped} 轮旧历史` : null,
      agentMeta?.turns ? `${agentMeta.turns} 轮` : null,
      agentMeta?.costUsd ? `$${agentMeta.costUsd.toFixed(3)}` : null,
      `${ms}ms`,
      thinking === 'on' ? 'think' : null,
      thinking === 'unsupported' ? '⚠ 上游不支持 think，已退回' : null,
      truncated ? '⚠ 已达 max_tokens，可能截断' : null,
    ].filter(Boolean).join(' · ');
  }

  hintFor(e) {
    if (e.code === 'NO_AGENT') return '在面板「配置」里选一个本地 agent 并点「检测」';
    if (e.code === 'AGENT_SPAWN') return '选中的 agent 没装或不在 PATH 上';
    if (e.code === 'AGENT_TIMEOUT') return 'agent 太久没返回；可在配置里调大超时或改用 LLM';
    if (['AGENT_EMPTY', 'AGENT_ERROR', 'AGENT_PARSE'].includes(e.code)) return 'agent 返回异常，看服务端日志';
    if (['NO_API_KEY', 'NO_MODEL', 'NO_BASEURL'].includes(e.code)) return '在面板「配置」里补齐翻译后端设置';
    return e.status ? `服务返回 ${e.status}` : '本地服务未启动？npm run server';
  }

  /**
   * 记下查询行为，供面板的「翻译 / 解释」tab 回看。
   * 翻译不进笔记库同步（服务端 db 层按 action 排除），解释会同步。
   */
  saveLookup(action, { text, value, anchor, extra = null }) {
    const draft = { action, text, extra };
    const key = lookupKey(draft);

    // 先按**内容**找已有记录：这样历史上那些随机 uuid 的旧记录也能被原地更新，
    // 不必迁移 id（迁移会牵动 synced 表里的引用）。找不到才用内容派生的稳定 id。
    const prev = this.items.find((e) => e.action === action && !e.deletedAt
      && lookupKey(e) === key);

    const ev = {
      id: prev?.id ?? lookupId(this.key, draft),
      urlKey: this.key, url: location.href, title: document.title,
      action, text, value, color: null,
      // 锚点由 snapshot() 在选中当时算好（见那里的注释）；缺失时沿用旧记录的
      anchor: anchor ?? prev?.anchor ?? null,
      parentId: null, extra,
      // 保留首次查询时间：列表记的是"你查过什么"，不是"最后一次查的时间"。
      // （列表已改为按文档位置排序，所以这里不再影响顺序，只影响条目上显示的时间，
      //   以及位置相同时的稳定排序。）
      createdAt: prev?.createdAt ?? Date.now(),
    };

    this.items = [...this.items.filter((e) => e.id !== ev.id), ev];
    this.persist([ev]);
    this.reanchor();          // 立刻在原文画出标记，不等下一次 MutationObserver
  }
}

/**
 * 防重复注入。
 *
 * 脚本可能被注入两次（userscript 手动再运行一次；扩展重载后旧 content script 仍在）。
 * shadowHost 每次都新建宿主，于是会出现**两套完整 UI**：两个工具条都响应 mousedown、
 * 两个浮层叠在一起，你看到的是上面那个而事件可能绑在下面那个上 —— 表现就是"点了没反应"。
 * 用 documentElement 上的标记做闸，第二次注入直接退出并说明原因。
 */
const MARK = 'contextflowLoaded';

/**
 * 显式启动，**不在模块加载时自动跑**。
 *
 * 两个载体都要在启动前先把传输层配好（扩展入口要 setTransport 换成走 service worker），
 * 若在 import 时就自动启动，那一步永远来不及。
 *
 * @returns {App|null} 已在运行则返回 null
 */
export function boot() {
  if (document.documentElement.dataset[MARK]) {
    console.warn('[ContextFlow] 本页已在运行，忽略这次重复注入'
      + '（重复注入会产生两套 UI，点击可能落到不可见的那一套上）。刷新页面可重置。');
    return null;
  }
  document.documentElement.dataset[MARK] = '1';
  const app = new App();
  // start 是异步的（要对账、上传正文），但调用方需要立刻拿到实例
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.start(), { once: true });
  } else {
    app.start();
  }
  return app;
}
