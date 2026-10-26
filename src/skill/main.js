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
//
// 不是每个页面都是阅读页：工具条末端的「停用」把整个插件按页面 / 站点关掉
// （名单与恢复路径见 blocklist.js），boot() 会先查名单再决定要不要启动。

import { buildTextIndex, serializeRange, resolveAnchor, charOffsetOf, boundaryOffset }
  from '../core/anchor.js';
import { Highlighter, COLORS, DARK_COLORS, MARKS, supported } from '../core/highlight.js';
import * as api from '../core/api.js';
import { T, FLOAT, shadowHost, onPageTheme, releaseThemeHost } from './theme.js';
import { Panel } from './panel.js';
import { Popover, ticker } from './popover.js';
import { CommentPopover } from './comment-popover.js';
import { MarkDeleteControl } from './mark-delete.js';
import { icon } from './icons.js';
import { cleanQuestion, lookupKey, lookupId, normalizeLookupPart, hashKey } from '../core/lookupkey.js';
import { reconcile } from '../core/reconcile.js';
import {
  available as offlineAvailable, migrateArticleMirror, listOfflineEvents,
  saveOfflineEvents, tombstoneOfflineEvents, applyRemoteEvents, mutationStamp,
  saveOfflineAsset, getOfflineAsset,
  migrateArticleIdentity,
} from '../core/offline-store.js';
import { renderArticleMarkdown, safeMarkdownFilename } from '../core/markdown.js';
import { assetIds, inlineAssetTokens } from '../core/assets.js';
import { urlKey, articleIdentity, eventIdentityKey } from '../core/urlkey.js';
import { articleSession } from './article-session.js';
import { browserStorage } from '../core/browser-storage.js';
import { randomUUID } from '../core/uuid.js';
import {
  blockedScope, blockPage, blockSite, showUnblockChip, BlockControl,
} from './blocklist.js';

const MIRROR = 'contextflow:v2:';

// 会在原文留标记的 action。直接由 MARKS 派生，避免两处各写一份而走形。
const MARKED = new Set(Object.keys(MARKS));

const mGet = (k) => { try { return JSON.parse(browserStorage().getItem(MIRROR + k) || '[]'); } catch { return []; } };
const mSet = (k, v) => { try { browserStorage().setItem(MIRROR + k, JSON.stringify(v)); } catch { /* 配额 */ } };

const TOOLBAR_CSS = `${FLOAT}
  .card{display:none;gap:2px;align-items:center;padding:5px 6px;border-radius:7px;
        background-color:${T.paper};
        background-image:radial-gradient(circle at 1px 1px,var(--cf-grain) .6px,transparent .7px);background-size:5px 5px}
  .sw{position:relative;width:18px;height:22px;margin:0 2px;border-radius:2px 2px 6px 2px;padding:0;
      border:1px solid ${T.lineStrong};box-shadow:inset 0 -2px 2px ${T.hover};
      transition:transform .14s ease,border-color .14s ease,filter .14s ease}
  .sw::after{content:'';position:absolute;left:3px;right:3px;top:3px;height:4px;border-top:1px solid rgba(255,255,255,.58);opacity:.75}
  .sw:hover{transform:translateY(-1px);border-color:${T.inkSoft};filter:saturate(1.08)}
${Object.entries(COLORS).map(([name, color]) => `  .sw[data-c="${name}"]{background:${color}}`).join('\n')}
${Object.entries(DARK_COLORS).map(([name, color]) => `  :host([data-theme=dark]) .sw[data-c="${name}"]{background:${color}}`).join('\n')}
  .sep{width:1px;height:23px;background:${T.line};margin:0 5px}
  .txt{display:inline-flex;align-items:center;gap:5px;min-height:31px;font-size:12.5px;font-weight:620;padding:5px 8px;background:transparent}
  .txt .ico{width:14px;height:14px;color:${T.quote}}
  .txt:hover .ico{color:${T.accent}}
  .txt.off{padding:5px 7px}
`;

export class App {
  constructor({ initialPanelOpen = null } = {}) {
    this.initialPanelOpen = typeof initialPanelOpen === 'boolean' ? initialPanelOpen : null;
    this.pendingPanelToggle = false;
    this.key = urlKey();
    this.identity = articleIdentity();
    this.articleUrl = this.identity.url || location.href;
    this.articleTitle = document.title || '';
    this.items = [...new Map([...(this.identity.legacyKey !== this.key ? mGet(this.identity.legacyKey) : []), ...mGet(this.key)]
      .filter(event => eventIdentityKey(event) === this.key).map(event => [event.id, { ...event, urlKey: this.key }])).values()];
    this.hl = new Highlighter();
    // 正文标记与 UI 用同一明暗判定源：页面实测背景，系统偏好只是兜底。
    this.unsubscribeTheme = onPageTheme((tone) => this.hl.setDark(tone === 'dark'));
    this.index = null;
    this.pos = new Map();          // id → 解析后的文档偏移，用于面板排序
    this.stats = { position: 0, quote: 0, fuzzy: 0, orphan: 0 };
    this.online = false;
    this.pendingCount = 0;
    this.timer = null;
    // 批注编辑器与右侧栏共用的即时草稿。事件记录仍是唯一持久化事实源；
    // 这里仅覆盖 500ms 防抖窗口，避免一边输入时另一边显示旧值。
    this.commentDrafts = new Map();
    // lookup id → 当前轮询的 AbortController。删除 pending 记录时用它中止轮询，
    // 也防止已经晚到的结果把已删除记录用稳定 id "复活"。
    this.lookupRuns = new Map();
    // 覆盖上传正文到轮询完成的整个提交窗口，避免连点重复排队。
    this.explainSubmissions = new Map();
    this.translationSubmissions = new Map();
  }

  async start() {
    this.retired = false; this.suspended = false;
    if (blockedScope(this.articleUrl)) { this.stopped = true; return; }
    this.stopped = false;
    this.hl = new Highlighter();
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = onPageTheme(tone => this.hl.setDark(tone === 'dark'));
    if (!supported()) return console.error('[ContextFlow] 浏览器不支持 CSS Custom Highlight API');
    if (offlineAvailable()) {
      const migration = await migrateArticleIdentity(this.identity);
      this.identityMigration = migration;
      await migrateArticleMirror(this.key, this.items);
      const durable = await listOfflineEvents(this.key);
      if (durable.length || !this.items.length) this.items = durable;
    }
    if (!this.isCurrentArticle()) return;
    // Do not expose editors until the private article store is readable. A
    // failed startup can then be retried without replacing uncommitted input.
    this.buildToolbar();
    this.markDelete = new MarkDeleteControl((id) => this.deleteMarked(id));
    this.blockMenu = new BlockControl((scope) => this.blockHere(scope));
    this.panel = new Panel(this.handlers());
    if (this.initialPanelOpen !== null) this.panel.toggle(this.initialPanelOpen, false);
    if (this.pendingPanelToggle) this.panel.toggle(!this.panel.open, false);
    this.pendingPanelToggle = false;
    this.reanchor();
    this.wire();
    this.resumePending();          // 接上刷新前没跑完的解释
    if (this.panel.open) this.autoSummarize();   // 只恢复已有结果或生成入口，不发起 AI。
    // Local records are ready independently of a slow/offline companion. A
    // route switch must never wait for network reconciliation or asset upload.
    this.sync().then(() => { if (this.isCurrentArticle() && this.panel.open) this.autoSummarize(); }).catch(error => console.warn('[ContextFlow] 连接状态暂未刷新：', error.message));
    if (this.identityMigration?.ambiguous) this.panel.syncMsg('部分历史记录的文章归属无法确认，已原样保留在阅读库；不会自动合并或删除。');
    console.log('[ContextFlow] 就绪', { key: this.key, n: this.items.length, online: this.online });
  }

  isCurrentArticle() {
    if (this.retired || this.suspended || this.stopped || urlKey() !== this.key) {
      if (!this.retired && !this.stopped && urlKey() !== this.key) this.onRouteChange?.();
      return false;
    }
    this.articleTitle = document.title || this.articleTitle;
    return true;
  }

  suspend() {
    if (this.retired) return;
    this.suspended = true; this.hideTb(); this.markDelete?.hide(); this.hl.clear();
    if (this.panel?.sh?.host) { this.panel.sh.host.inert = true; this.panel.sh.host.setAttribute('aria-busy', 'true'); }
  }

  async flushForNavigation() {
    await this.panel?.flushEdits?.();
    // Shared drafts can outlive a blurred/closed composer for one debounce.
    await Promise.all([...this.commentDrafts].map(([id, value]) => this.commitCommentDraft(id, value, 'navigation')));
    if (this.noteDraft != null) { const value = this.noteDraft; await this.saveNote(value); if (this.noteDraft === value) this.noteDraft = null; }
    if (this.failedLocalEvents?.size) await this.persist([...this.failedLocalEvents.values()]);
    await Promise.all(this.localSaves || []);
  }

  navigationFailed(error) {
    if (this.panel?.sh?.host) { this.panel.sh.host.inert = false; this.panel.sh.host.removeAttribute('aria-busy'); }
    this.panel?.syncMsg?.(`上一页草稿尚未保存，暂未切换阅读记录：${error.message}。请保留此页，完成图片保存或复制内容备份。`, 'bad');
  }

  hasBackgroundWork() { return !!(this.lookupRuns.size || this.explainSubmissions.size || this.translationSubmissions.size || this.briefBusy); }

  deactivate() {
    this.retired = true; this.suspended = true;
    this.observer?.disconnect(); clearTimeout(this.timer);
    for (const [target, type, listener, options] of this.pageListeners || []) target.removeEventListener(type, listener, options);
    this.pageListeners = [];
    this.unsubscribeTheme?.(); this.unsubscribeTheme = null;
    this.hl.clear(); this.hl._styleEl?.remove();
    this.commentPop?.dispose?.();
    for (const pop of Object.values(this.pops || {})) pop.dispose?.();
    this.markDelete?.dispose?.(); this.blockMenu?.dispose?.(); this.panel?.dispose?.();
    const toolbarHost = this.tb?.getRootNode?.().host;
    releaseThemeHost(toolbarHost); toolbarHost?.remove();
    this.commentPop = null; this.pops = null;
    for (const url of this.assetUrls?.values?.() || []) URL.revokeObjectURL(url);
    this.assetUrls?.clear?.();
    // Background callbacks may persist their own article, but cannot repaint or
    // restore the root margin of a new page. This is not a canceled AI request.
    this.panel = { render() {}, renderStatus() {}, renderBrief() {}, renderLookupPreview() {}, syncMsg() {} };
  }

  /**
   * 切换现有面板。公开userscript重复执行时走这里，避免再次构造整套 UI。
   * DOM 尚未 ready 时先记下意图，Panel 创建后再应用。
   */
  togglePanel() {
    // 已停用的页面：重新执行userscript是用户的主动敲门，接住并给出恢复入口
    if (this.stopped) return showUnblockChip();
    if (this.panel) {
      this.panel.toggle();
      return;
    }
    if (this.initialPanelOpen !== null) this.initialPanelOpen = !this.initialPanelOpen;
    else this.pendingPanelToggle = !this.pendingPanelToggle;
  }

  handlers() {
    return {
      getItems: () => this.items.filter((e) => e.action === 'highlight'),
      getStats: () => this.stats,
      getNote: () => this.noteDraft ?? this.noteItem()?.value ?? '',
      isOnline: () => this.online,
      canConnectService: () => typeof this.openConnectionSettings === 'function',
      getConnectionIssue: () => this.connectionIssue,
      onOpenConnection: () => this.openConnectionSettings?.(),
      canOpenLibrary: () => typeof this.openReadingLibrary==='function',
      onOpenLibrary: () => this.openReadingLibrary?.(),
      onConfigurationSaved: () => this.refreshConnection(),
      outbox: () => this.pendingCount,
      positionOf: (id) => this.pos.get(id) ?? Number.MAX_SAFE_INTEGER,
      isOrphan: (id) => !this.hl.has(id),
      colorOf: (id) => COLORS[this.items.find((e) => e.id === id)?.color] ?? COLORS.yellow,
      commentOf: (id) => this.commentValue(id),
      isCommentEditing: (id) => this.editingCommentId === id && !!this.commentPop?.open$,
      onCommentInput: (id, v) => this.updateCommentDraft(id, v, 'panel'),
      onCommentChange: (id, v) => this.commitCommentDraft(id, v, 'panel'),
      onNoteInput: (v) => { this.noteDraft = String(v ?? ''); },
      onNoteChange: async (v) => { await this.saveNote(v); if (this.noteDraft === v) this.noteDraft = null; },
      getLookupSupplement: (id) => this.items.find((e) => e.id === id)?.extra?.supplement ?? '',
      onLookupSupplementInput: (id, v) => this.updateLookupSupplement(id, v, false, 'panel'),
      onLookupSupplementChange: (id, v) => this.updateLookupSupplement(id, v, true, 'panel'),
      onAsset: (file) => this.addAsset(file),
      resolveAsset: (id) => this.resolveAsset(id),
      onDelete: (id) => this.deleteHighlight(id),
      onLocate: (id) => this.locate(id),
      api,
      onReanchor: () => this.reanchor(),
      // 只做筛选，排序统一交给 panel 的 byPosition（见 core/order.js）
      getLookups: (kind) => this.items.filter((e) => e.action === kind && !e.deletedAt),
      onDeleteLookup: (id) => this.deleteLookup(id),
      onUndoDelete: () => this.undoDelete(),
      onOpenRecord: (id) => this.openRecord(id),
      onCopyAnswer: (text) => this.copyText(text),
      onCancelLookup: (id) => this.cancelLookup(id),
      onCancelSummary: () => this.cancelSummary(),
      onFlushEdits: () => this.flushInlineEdits(),
      // Panel 构造时会恢复“上次保持展开”的状态；把速览放到微任务，
      // 等 this.panel 完成赋值后再执行，避免刷新时访问尚未挂载的 panel。
      onOpen: () => queueMicrotask(() => this.autoSummarize()),
      onSummarize: (fresh) => this.autoSummarize(fresh),
      onRetryLookup: (id) => this.retryLookup(id),
      onCopyMarkdown: () => this.copyMarkdown(),
      onDownloadMarkdown: () => this.downloadMarkdown(),
      onSync: async () => {
        await this.flushInlineEdits();
        await api.flushAssets();
        // Another autosave may already hold a queue lease. Wait for its ack,
        // otherwise /sync can run before the last edit reaches the companion.
        const deadline = Date.now() + 8000;
        do {
          await api.flushOutbox();
          if (!await api.outboxSize(this.key)) break;
          if (Date.now() >= deadline) throw new Error('记录已保存在浏览器，但仍有内容待发送；请检查本地服务，稍后再次同步。');
          await new Promise(resolve => setTimeout(resolve, 120));
        } while (true);
        const r = await api.sync(this.key);
        await this.sync();          // 同步后回读，刷新「待同步」计数
        return r;
      },
      onBlock: (scope) => this.blockHere(scope),
    };
  }

  // ---------- 停用 ----------

  /**
   * 用户主动停用：落名单 → 就地撤下 → 弹恢复卡片。
   * 卡片既是确认（看得见"已停用"），也是唯一的反悔出口。
   */
  blockHere(scope) {
    if (scope === 'site') blockSite();
    else blockPage();
    this.stop();
    showUnblockChip(scope);
  }

  /**
   * 就地停用：撤下注入的全部 UI 与标记，但**不刷新页面** ——
   * 被停用的往往不是阅读页（管理后台、编辑器），刷新可能丢掉用户正在编辑的状态。
   * document 上的监听器无法逐个摘除，靠 this.stopped 让残余处理器立即返回；
   * 轮询中的查询直接中止，晚到的结果不该写回一个已经停用的页面。
   */
  stop() {
    this.stopped = true;
    this.observer?.disconnect();
    clearTimeout(this.timer);
    for (const ctl of this.lookupRuns.values()) ctl.abort();
    this.lookupRuns.clear();
    this.briefController?.abort();
    for (const run of this.translationSubmissions.values()) run.canceled = true;
    this.translationSubmissions.clear();
    this.unsubscribeTheme?.(); this.unsubscribeTheme = null;
    for (const [target, type, listener, options] of this.pageListeners || []) target.removeEventListener(type, listener, options);
    this.pageListeners = [];
    // 停用 / 重载插件前先提交未落盘的批注，不能丢掉最后 500ms 内的输入。
    this.commentPop?.close();
    for (const pop of Object.values(this.pops || {})) pop.close();
    for (const url of this.assetUrls?.values?.() || []) URL.revokeObjectURL(url);
    this.assetUrls?.clear?.();
    this.hl.clear();
    // push 模式的面板给 <html> 挂过 margin-right 挤开正文 —— 面板要撤了，
    // 正文必须还回去，否则页面留着一条永远填不上的右白边。
    // 不走 panel.toggle(false)：那会把「面板展开」的记忆也改掉，停用不该动它。
    if (this.panel?.rootMarginBefore != null) {
      const root = document.documentElement;
      root.style.marginRight = this.panel.rootMarginBefore;
      root.style.transition = this.panel.rootTransitionBefore || '';
      this.panel.rootMarginBefore = null;
      this.panel.rootTransitionBefore = null;
    }
    // 我们注入的所有宿主元素（工具条、面板、浮层、恢复卡片）都带 data-contextflow
    // 标记，head 里那份高亮样式表也一样 —— 一网打尽，页面上不留痕
    document.querySelectorAll('[data-contextflow]').forEach((el) => el.remove());
    console.log('[ContextFlow] 已停用，恢复方式见恢复卡片或重新运行脚本');
  }

  // ---------- 服务对账 ----------
  async refreshConnection() {
    if (this.stopped) return;
    await this.sync();
    if (this.stopped || this.briefBusy) return;
    const hasBrief = this.items.some((event) => event.action === 'summary' && event.value && !event.deletedAt);
    if (!hasBrief && this.online) this.panel.renderBrief({
      state: 'idle', text: this.serviceInfo?.explainConfigured === false
        ? '服务已连接。可先同步笔记，需要 AI 时再配置模型。'
        : '连接与配置已更新。需要时点击生成速览，不会因重新连接自动调用模型。',
      configure: this.serviceInfo?.explainConfigured === false,
      retry: this.serviceInfo?.explainConfigured !== false, initial: true,
    });
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.reconcileService();
    try { await this.syncing; } finally { this.syncing = null; }
  }

  async reconcileService() {
    try {
      this.serviceInfo = await api.health();
      this.online = true;
      this.connectionIssue = null;
      await api.flushAssets();
      const flushed = await api.flushOutbox();
      if (flushed) console.log(`[ContextFlow] 补发 ${flushed} 条积压`);
      // 取数据前先记下本地都有哪些 id：await 期间用户可能又划了一条，
      // 那条服务端还没有，不能被当成"服务端已删"抹掉。
      const localBefore = new Set(this.items.map((e) => e.id));
      const remote = await api.fetchEvents(this.key);
      const pending = await api.outboxSize(this.key);
      this.pendingCount = pending;
      this.items = reconcile(this.items, remote, { pending, localBefore });
      if (offlineAvailable()) {
        await applyRemoteEvents(remote);
        // 把 reconcile 保住的请求期新增/本地 pending 同样写回 durable store，再吸收其他 tab。
        await saveOfflineEvents(this.items, { queue: false });
        this.items = await listOfflineEvents(this.key);
      }
      mSet(this.key, this.items);
      this.reanchor();
    } catch (e) {
      this.online = false;
      this.connectionIssue = e.code || 'SERVICE_UNAVAILABLE';
      console.warn('[ContextFlow] 本地服务不可达，离线模式：', e.message);
    }
    this.panel.render();
    if (!this.retired && this.identityMigration?.deferred) {
      try { this.identityMigration = await migrateArticleIdentity(this.identity); } catch { /* durable alias reads remain available */ }
    }
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
        urlKey: this.key, title: this.articleTitle, url: this.articleUrl, text,
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
    const stamped = events.map((event) => {
      const next = mutationStamp(event);
      Object.assign(event, next);
      return event;
    });
    mSet(this.key, this.items);
    // api.pushEvents 会把事件与 queued operation 原子写入 IDB，再尝试网络发送。
    let saved, failed;
    const local = new Promise((resolve, reject) => { saved = resolve; failed = reject; });
    let localSaved = false;
    const markLocalSaved = () => {
      localSaved = true;
      for (const event of stamped) this.failedLocalEvents?.delete(event.id);
      saved();
    };
    api.pushEvents(stamped, { onLocalSaved: markLocalSaved }).then(async (ok) => {
      markLocalSaved(); // 非 IndexedDB 载体的兼容兜底。
      this.pendingCount = await api.outboxSize(this.key);
      if (ok !== this.online) { this.online = ok; this.panel.renderStatus(); }
    }).catch((error) => {
      if (!localSaved) {
        this.failedLocalEvents ??= new Map();
        for (const event of stamped) this.failedLocalEvents.set(event.id, event);
      }
      failed(error);
      this.panel?.syncMsg?.(localSaved ? `记录已保存在浏览器，但服务状态暂无法确认：${error.message}`
        : `浏览器保存失败，请保留当前页面并复制内容备份：${error.message}`, 'bad');
    });
    // 其余即时高亮入口可能不等待；错误已在上方显示，不产生未处理的拒绝。
    local.catch(() => {});
    this.localSaves ??= new Set(); this.localSaves.add(local);
    local.then(() => this.localSaves.delete(local), () => this.localSaves.delete(local));
    return local;
  }

  // ---------- 锚定 ----------
  reanchor() {
    if (!this.isCurrentArticle()) return;
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

  scheduleReanchor() {
    if (!this.isCurrentArticle()) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => this.reanchor(), 400);
  }

  noteItem() { return this.items.find((e) => e.action === 'note'); }
  commentFor(id) { return this.items.find((e) => e.action === 'comment' && e.parentId === id && !e.deletedAt); }
  commentValue(id) {
    return this.commentDrafts.has(id) ? this.commentDrafts.get(id) : (this.commentFor(id)?.value ?? '');
  }

  /** 原位编辑器惰性创建；输入、持久化、关闭三条路径都回到 App 统一分发。 */
  commentTipFor() {
    if (this.commentPop) return this.commentPop;
    this.commentPop = new CommentPopover({
      onInput: (id, v) => this.updateCommentDraft(id, v, 'popover'),
      onCommit: (id, v) => this.commitCommentDraft(id, v, 'popover'),
      onAsset: (file) => this.addAsset(file),
      resolveAsset: (id) => this.resolveAsset(id),
      onClose: (id) => {
        if (this.editingCommentId === id) this.editingCommentId = null;
        this.panel?.markCommentEditing(id, false);
      },
    });
    return this.commentPop;
  }

  openCommentEditor(item, rect) {
    if (!item) return;
    const prev = this.editingCommentId;
    const tip = this.commentTipFor();
    tip.open(rect, {
      id: item.id, source: item.text || '', value: this.commentValue(item.id),
    });
    // The previous editor may still own a pending image. Keep its identity and
    // sidebar marker until it is safe to switch, including late asset callbacks.
    if (!tip.open$ || tip.id !== item.id) return false;
    if (prev && prev !== item.id) this.panel?.markCommentEditing(prev, false);
    this.editingCommentId = item.id;
    this.panel?.markCommentEditing(item.id, true);
    return true;
  }

  /**
   * 任一编辑入口的每次按键都先写共享草稿，并立即镜像到另一处；真正持久化由各入口
   * 的 500ms 防抖 / blur 触发 commitCommentDraft，避免按键级网络写入。
   */
  updateCommentDraft(id, raw, source) {
    const value = String(raw ?? '');
    this.commentDrafts.set(id, value);
    if (source === 'panel') this.commentPop?.setValue(id, value);
    else this.panel?.updateCommentDraft(id, value);
  }

  async commitCommentDraft(id, raw, source) {
    this.updateCommentDraft(id, raw, source);
    await this.saveComment(id, raw);
    // 共享草稿只覆盖防抖窗口；落盘后继续以事件记录为唯一事实源，
    // 后续同步进来的更新就不会被一份永久驻留的本地草稿遮住。
    if (this.commentDrafts.get(id) === String(raw ?? '')) {
      this.commentDrafts.delete(id);
      this.commentPop?.markSaved(id, raw);
    }
    this.panel?.renderStatus();
  }

  async addAsset(file) {
    const asset = await saveOfflineAsset(file);
    if (!this.assetUrls?.has(asset.id)) {
      this.assetUrls ??= new Map();
      this.assetUrls.set(asset.id, URL.createObjectURL(asset.blob));
    }
    // 本地落盘就是成功；服务没开时保留 uploadedAt=0，下一次 sync() 会补传。
    api.pushAsset(asset).catch((e) => console.warn('[ContextFlow] 附件暂未上传：', e.message));
    return { id: asset.id, alt: file?.name?.replace(/\.[^.]+$/, '') || '截图' };
  }

  async resolveAsset(id) {
    this.assetUrls ??= new Map();
    if (this.assetUrls.has(id)) return this.assetUrls.get(id);
    let asset = await getOfflineAsset(id);
    if (!asset && this.online) {
      try { asset = await api.fetchAsset(id); } catch { /* 服务端也没有：由编辑器显示占位 */ }
    }
    if (!asset?.blob) return null;
    const url = URL.createObjectURL(asset.blob);
    this.assetUrls.set(id, url);
    return url;
  }

  updateLookupSupplement(id, raw, commit, source) {
    const ev = this.items.find((e) => e.id === id);
    if (!ev) return;
    const supplement = String(raw ?? '');
    ev.extra = { ...(ev.extra || {}), supplement };
    mSet(this.key, this.items);
    if (source === 'panel') this.pops?.explain?.setSupplementValue(id, supplement);
    else this.panel?.updateLookupSupplement(id, supplement);
    if (commit) return this.persist([ev]);
  }

  locate(id) {
    const rect = this.hl.rectOf(id);
    if (!rect) return;
    // 优先让 Range 所在元素自行进入视口：它能同时处理 window 和正文内部滚动容器。
    // 极少数 Range 没有可滚动元素时，再退回页面级坐标定位。
    if (!this.hl.scrollIntoView(id)) {
      scrollTo({ top: scrollY + rect.top - innerHeight * 0.35, behavior: 'smooth' });
    }
    this.hl.flash(id);
  }

  // ---------- 划词工具条 ----------
  buildToolbar() {
    const sh = shadowHost('toolbar', TOOLBAR_CSS, 2147483647);
    sh.innerHTML += `<div class="card r" id="tb" role="toolbar" aria-label="选中文本操作">
      ${Object.keys(COLORS).map((c) =>
        `<button class="sw" data-c="${c}" title="高亮" aria-label="${c} 高亮"></button>`).join('')}
      <span class="sep" aria-hidden="true"></span>
      <button class="txt" data-a="comment" title="高亮并写批注">${icon('comment')}<span>批注</span></button>
      <button class="txt" data-a="explain" title="就这段内容提问">${icon('explain')}<span>解释</span></button>
      <button class="txt" data-a="translate" title="翻译选中文本">${icon('translate')}<span>翻译</span></button>
      <span class="sep" aria-hidden="true"></span>
      <button class="txt off" data-a="disable" title="在此页面或站点停用 ContextFlow" aria-label="停用 ContextFlow">${icon('power')}</button>
    </div>`;
    this.tb = sh.getElementById('tb');
    // mousedown + preventDefault：点击若走 click 事件，选区已被清掉
    this.tb.addEventListener('mousedown', (e) => {
      const b = e.target.closest?.('button');
      if (!b) return;
      e.preventDefault();
      if (b.dataset.a === 'disable') {
        // 停用不需要选区，菜单锚定在按钮自身；工具条先留着，方便看清菜单贴着谁
        this.blockMenu?.show(b.getBoundingClientRect());
        return;
      }
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
    this.pageListeners = [];
    const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); this.pageListeners.push([target, type, fn, options]); };
    const win = document.defaultView || globalThis;
    listen(document, 'mouseup', () => setTimeout(() => {
      if (!this.isCurrentArticle()) return;
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hideTb();
      const range = sel.getRangeAt(0);
      if (!String(range).trim()) return this.hideTb();
      const a = range.commonAncestorContainer;
      const el = a.nodeType === 1 ? a : a.parentElement;
      if (el?.closest?.('[data-contextflow]')) return this.hideTb();
      const r = range.getBoundingClientRect();
      this.tb.style.display = 'flex';
      // 居中贴在选区上方；上方不够再翻到下方。高度也要量 —— 图标化后工具条
      // 不再恒高，写死偏移会压住第一行文字。
      const box = this.tb.getBoundingClientRect();
      const width = box.width || 292, height = box.height || 48;
      const center = r.left + r.width / 2;
      const left = Math.min(Math.max(8, center - width / 2), Math.max(8, innerWidth - width - 8));
      const above = r.top - height - 10;
      const top = above >= 8 ? above : Math.min(r.bottom + 10, Math.max(8, innerHeight - height - 8));
      this.tb.style.left = `${Math.round(left)}px`;
      this.tb.style.top = `${Math.round(top)}px`;
    }, 0));

    // 翻译面板是常驻的（由 × 或点击页面空白关闭），滚动只收工具条
    listen(win, 'scroll', () => this.hideTb(), { passive: true });

    listen(document, 'click', (e) => {
      if (!this.isCurrentArticle()) return;
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
        if (!this.isCurrentArticle()) return;
        if (!this.hl.has(id) || !this.items.some((x) => x.id === id)) return;
        const rect = this.hl.endRectOf(id);
        if (!rect) return this.markDelete?.hide();
        const label = act === 'highlight' ? '删除此高亮'
          : act === 'translate' ? '删除此翻译记录' : '删除此解释记录';
        this.markDelete?.show(id, rect, label);
      });
    });

    this.observer = new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target, el = t.nodeType === 1 ? t : t.parentElement;
        if (el?.closest?.('[data-contextflow]')) continue;   // 忽略自己造成的变动
        return this.scheduleReanchor();
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
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
    if (!this.isCurrentArticle()) return;
    // 选区会在持久化前被清掉，原位编辑器所需的坐标必须先快照。
    const commentRect = openComment ? range.getBoundingClientRect() : null;
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
      id: randomUUID(), urlKey: this.key, url: this.articleUrl,
      title: this.articleTitle, action: 'highlight', text: anchor.exact,
      value: null, color, anchor, parentId: null, createdAt: Date.now(),
    };
    this.items.push(ev);
    this.persist([ev]);
    getSelection()?.removeAllRanges();
    this.hideTbSoon();
    this.reanchor();
    // 批注从原文旁开始写，不再强制展开右栏、打断阅读视线；右栏仍会实时拿到同一草稿。
    if (openComment) this.openCommentEditor(ev, commentRect);
  }

  saveComment(highlightId, raw) {
    const body = (raw ?? '').trim();
    const parent = this.items.find((e) => e.id === highlightId);
    if (!parent || parent.deletedAt) return; // delayed blur/paste after deletion
    let c = this.commentFor(highlightId);
    if (!c) {
      if (!body) return;
      c = {
        id: randomUUID(), urlKey: this.key, url: this.articleUrl,
        title: this.articleTitle, action: 'comment', text: parent?.text ?? null,
        value: body, color: null, anchor: parent?.anchor ?? null,
        parentId: highlightId, createdAt: Date.now(),
      };
      this.items.push(c);
    } else {
      // 显式重试时，即使内存中的文字相同，也要重做落盘；上次可能因配额失败。
      c.value = body;
      if (!body) c.deletedAt = Date.now();
    }
    const saved = this.persist([c]);
    if (c.deletedAt) this.items = this.items.filter((e) => e.id !== c.id);
    return saved;
  }

  /** 原文上的 × 统一分派到已有删除路径，不复制状态/API 逻辑 */
  deleteMarked(id) {
    const it = this.items.find((e) => e.id === id);
    if (!it) return;
    if (it.action === 'highlight') this.deleteHighlight(id);
    else if (MARKED.has(it.action)) this.deleteLookup(id);
  }

  async deleteHighlight(id) {
    this.markDelete?.hide();
    if (this.editingCommentId === id) this.commentPop?.close(false);
    const draft = this.commentDrafts.get(id);
    this.commentDrafts.delete(id);
    const h = this.items.find((e) => e.id === id);
    const c = this.commentFor(id);
    const dead = [h, c].filter(Boolean);
    if (!h) return;
    const restore = structuredClone(dead);
    if (draft !== undefined) {
      const comment = restore.find(e => e.action === 'comment');
      if (comment) comment.value = draft;
      else if (draft.trim()) restore.push({ ...h, id: randomUUID(), action: 'comment', parentId: id, value: draft, color: null });
    }
    this.items = this.items.filter((e) => e.id !== id && e.id !== c?.id);
    mSet(this.key, this.items);
    await this.recordDeletion(dead, restore);
    this.reanchor();
  }

  async deleteLookup(id) {
    this.markDelete?.hide();
    const ev = this.items.find((e) => e.id === id);
    if (!ev) return;
    const jobId = ev?.extra?.jobId;
    // 中止浏览器侧的轮询；服务端作业也 best-effort 取消，别让已删除的问题继续耗额度
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.delete(id);
    if (ev) this.explainSubmissions.delete(lookupKey(ev));
    if (jobId) api.cancelJob(jobId);
    this.items = this.items.filter((e) => e.id !== id);
    mSet(this.key, this.items);
    await this.recordDeletion([ev]);
    if (this.watching === id) this.tipFor('explain').close();
    this.reanchor();          // 顺带抹掉原文上的标记
  }

  async recordDeletion(events, restore = structuredClone(events)) {
    const entry = { events: restore, at: Date.now() };
    // A stack allows multiple deletions to be recovered in reverse order.
    this.deletedRecords ??= [];
    this.deletedRecords.push(entry);
    if (this.deletedRecords.length > 20) this.deletedRecords.shift();
    try {
      if (offlineAvailable()) {
        const dead = await tombstoneOfflineEvents(events);
        entry.at = Math.max(entry.at, ...dead.map(e => e.updatedAt || 0));
        api.flushOutbox().catch(() => {});
      } else await Promise.all(events.map(e => api.deleteEvent(e)));
      entry.ready = true;
      this.panel?.showUndo?.(`已删除${events.some(e => e.action === 'highlight') ? '批注' : '记录'} · 可撤销`);
    } catch (error) {
      this.deletedRecords = this.deletedRecords.filter(e => e !== entry);
      this.items.push(...restore); this.reanchor();
      throw error;
    }
  }

  async undoDelete() {
    const entry = this.deletedRecords?.at(-1);
    if (!entry?.ready) return;
    const restored = entry.events.map(e => ({ ...structuredClone(e), deletedAt: null,
      updatedAt: Math.max(Date.now(), entry.at + 1, (e.updatedAt || 0) + 1),
      ...(e.extra?.status === 'running' ? { extra: { ...e.extra, status: 'canceled', jobId: null, progress: '', error: '' } } : {}),
    }));
    const before = this.items;
    this.items = [...this.items.filter(e => !restored.some(r => r.id === e.id)), ...restored];
    try { await this.persist(restored); }
    catch (error) { this.items = before; this.reanchor(); throw error; }
    this.deletedRecords.pop(); this.reanchor();
    if (this.deletedRecords.length) queueMicrotask(() => this.panel?.showUndo?.('记录已恢复 · 还可撤销上一次删除'));
    this.panel?.syncMsg?.('记录已恢复，原文定位与笔记同步会一并更新。', 'ok');
    return this.deletedRecords.length;
  }

  openRecord(id) {
    const event = this.items.find(e => e.id === id && !e.deletedAt);
    if (!event) return;
    const range = this.hl.items.get(id)?.range;
    if (!range) {
      this.panel?.syncMsg?.('原文暂未定位，仍可在阅读记录中编辑、重试和复制。', 'bad'); return;
    }
    this.locate(id);
    if (event.action === 'highlight') return this.openCommentEditor(event, range.getBoundingClientRect());
    if (event.action === 'translate') {
      this.tipFor('translate').open(range.getBoundingClientRect()).answer(event.value || '尚无翻译结果'); return;
    }
    this.doExplain(range);
    const pop = this.tipFor('explain');
    if (event.value) pop.answer(event.value);
    pop.focus(event.extra?.question || '').supplement?.(id, event.extra?.supplement || '');
    this.syncExplainSubmit(pop);
  }

  async cancelLookup(id) {
    const event = this.items.find(e => e.id === id);
    if (!event || event.extra?.status !== 'running') return;
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.delete(id);
    this.explainSubmissions.delete(lookupKey(event));
    const jobId = event.extra?.jobId;
    this.patchLookup(id, { status: 'canceled', progress: '', error: '', jobId: null });
    if (jobId) api.cancelJob(jobId);
    if (this.watching === id && this.pops?.explain?.open$) {
      const pop = this.pops.explain;
      if (event.value) pop.answer(event.value).foot('已取消重新生成，保留原答案');
      else pop.body('已取消，可重新提问。').foot('');
    }
    this.syncExplainSubmit();
  }

  saveNote(body) {
    let n = this.noteItem();
    if (!n) {
      // id 由 urlKey 派生：同一篇文章的笔记始终 upsert 同一行，不会越写越多
      n = {
        id: `note:2:${hashKey(this.key)}`, urlKey: this.key, url: this.articleUrl,
        title: this.articleTitle, action: 'note', text: null, value: body,
        color: null, anchor: null, parentId: null, createdAt: Date.now(),
      };
      this.items.push(n);
    } else {
      // Retrying an unchanged draft must retry durability after a failed save.
      n.value = body;
    }
    const saved = this.persist([n]);
    this.panel.renderStatus();
    return saved;
  }

  async flushInlineEdits() {
    const supplement = this.pops?.explain?.supplementComposer;
    if ([this.commentPop?.composer, supplement].some(editor => editor?.blocks?.some(block => block.pending || block.error))) {
      throw new Error('原位面板中有图片尚未保存完成，请等待完成或移除失败图片后重试。');
    }
    if (await this.commentPop?.commit() === false) throw new Error('原位批注尚未保存成功，请先重试保存或复制备份。');
    await supplement?.commit();
  }

  // ---------- 划词查询：翻译 / 解释 ----------

  /** 两个浮层惰性创建，避免未用到的功能也注入 DOM */
  tipFor(kind) {
    this.pops ??= {};
    if (this.pops[kind]) return this.pops[kind];
    return (this.pops[kind] = kind === 'translate'
      ? new Popover({ name: 'tip-translate', title: '翻译', showSource: false })
      : new Popover({
        name: 'tip-explain', title: '解释', input: true,
        placeholder: '想问什么？留空则直接解释这段（Enter 提交）',
        submitLabel: '提问',
        supplement: true,
        onSubmit: (q) => this.runExplain(q),
        onRefresh: (q) => this.runExplain(q, true),
        onQuestionChange: () => this.syncExplainSubmit(),
        onSupplementInput: (id, value) => this.updateLookupSupplement(id, value, false, 'popover'),
        onSupplementCommit: (id, value) => this.updateLookupSupplement(id, value, true, 'popover'),
        onAsset: (file) => this.addAsset(file),
        resolveAsset: (id) => this.resolveAsset(id),
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
    if (!this.isCurrentArticle()) return;
    const text = String(range).trim();
    const { anchor, offset } = this.snapshot(range);
    const pop = this.tipFor('translate');
    this.hideTbSoon();
    pop.open(range.getBoundingClientRect()).foot('');
    const subject = normalizeLookupPart(text);
    const existing = this.translationSubmissions.get(subject);
    if (existing) {
      existing.pop = pop; pop.articleTranslationToken = existing.token;
      pop.body('这段翻译仍在处理中，完成后会保存在当前文章。', 'prog');
      return existing.promise;
    }
    const run = { token: Symbol('translation'), pop };
    this.translationSubmissions.set(subject, run); pop.articleTranslationToken = run.token;
    const tk = ticker(pop, '翻译中');
    const visible = () => this.isCurrentArticle() && run.pop?.open$ && run.pop.articleTranslationToken === run.token;
    run.promise = (async () => {
    try {
      await this.uploadArticle();      // 按需：只为真正查过的页面存正文
      if (run.canceled || this.stopped) return;
      const { translation, cached, usage, model, truncated, target, ctx } =
        await api.translate(text, undefined, this.key, offset);
      if (run.canceled || this.stopped) return;
      if (target) this.target = target;
      const ms = tk.stop();
      if (visible()) {
        run.pop.answer(translation).foot(this.meta({ cached, usage, model, truncated, ms, ctx }));
      }
      this.saveLookup('translate', { text, value: translation, anchor,
        extra: { target: this.target || '' } });
    } catch (e) {
      tk.stop();
      if (run.canceled || this.stopped) return;
      const status = this.online && e.status ? 'error' : 'deferred';
      this.saveLookup('translate', {
        text, value: null, anchor,
        extra: { target: this.target || '', offset, status, error: e.message,
          progress: status === 'deferred' ? '离线，已保存；联网后手动重试' : '' },
      });
      if (visible()) run.pop.body(`翻译失败：${e.message}`, 'bad').foot(status === 'deferred'
        ? '已保存到本地；恢复联网后请在「翻译」页点重试，不会自动产生费用'
        : this.hintFor(e));
    } finally { tk.stop(); if (this.translationSubmissions.get(subject) === run) this.translationSubmissions.delete(subject); }
    })();
    return run.promise;
  }

  /** 解释分两步：先弹输入框拿补充问题，再请求。留空也可直接提交。 */
  doExplain(range) {
    if (!this.isCurrentArticle()) return;
    const text = String(range).trim();
    // 锚点在这里就定下来，不留到提交时再算（那时 range 可能已失效）
    this.explainCtx = { text, rect: range.getBoundingClientRect(), ...this.snapshot(range) };
    this.hideTbSoon();
    const pop = this.tipFor('explain').open(this.explainCtx.rect, text)
      .body('').foot('').showRefresh(false);
    pop.supplement?.(null);
    // 同一段可以问多个问题；重开时恢复最近那次，而不是只找“空问题”的记录。
    const subject = normalizeLookupPart(text);
    const prev = this.items
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => e.action === 'explain' && !e.deletedAt
        && normalizeLookupPart(e.text) === subject)
      .sort((a, b) => (b.e.updatedAt || b.e.createdAt || 0) - (a.e.updatedAt || a.e.createdAt || 0)
      || b.index - a.index)[0]?.e;
    const question = cleanQuestion(prev?.extra?.question);
    if (prev) pop.supplement?.(prev.id, prev.extra?.supplement || '');
    if (prev?.value) pop.answer(prev.value).foot('本地已有回答 · 点击上方重新解释，或修改问题后提问').showRefresh(true);
    else if (prev?.extra?.status === 'running') pop.body(prev.extra.progress || '这段正在解释中…', 'prog');
    else if (prev?.extra?.status === 'deferred') pop.body('当前离线，记录已保留', 'bad');
    else if (prev?.extra?.status === 'error') pop.body(`解释失败：${prev.extra.error || '未知错误'}`, 'bad');
    pop.focus(question);
    this.syncExplainSubmit(pop);
  }

  /** 按当前选区和输入的问题决定提交含义，不让长答案藏住重试入口。 */
  syncExplainSubmit(pop = this.pops?.explain) {
    if (!pop?.submitState || !this.explainCtx) return;
    const key = lookupKey({ action: 'explain', text: this.explainCtx.text,
      extra: { question: cleanQuestion(pop.question()) } });
    const prev = this.items.find((e) => e.action === 'explain' && !e.deletedAt && lookupKey(e) === key);
    const busy = this.explainSubmissions.has(key) || this.lookupRuns.has(prev?.id);
    const failed = ['error', 'deferred'].includes(prev?.extra?.status);
    pop.submitState(busy ? '处理中…' : prev?.value ? '重新解释' : failed ? '重试' : '提问', busy);
    pop.showRefresh(!busy && !!prev?.value);
  }

  async runExplain(question, fresh = false) {
    if (!this.isCurrentArticle()) return;
    const pop = this.tipFor('explain');
    const ctx = this.explainCtx;
    // 静默 return 会表现成"点了提问毫无反应"，和卡死无从区分
    if (!ctx) {
      pop.body('选区已丢失，请重新划选后再提问。', 'bad').foot('');
      return;
    }
    question = cleanQuestion(question);
    const seed = { action: 'explain', text: ctx.text, extra: { question } };
    const key = lookupKey(seed);
    const prev = this.items.find((e) => e.action === 'explain' && !e.deletedAt
      && lookupKey(e) === key);
    if (this.explainSubmissions.has(key) || this.lookupRuns.has(prev?.id)) return;
    // 重开只读缓存；主动提交已有问题则明确请求新答案，包括失败后的重试。
    fresh ||= !!prev?.value || ['error', 'deferred'].includes(prev?.extra?.status);
    const submission = Symbol('explain-request');
    this.explainSubmissions.set(key, submission);
    this.syncExplainSubmit(pop);
    pop.foot('').showRefresh(false);
    const tk = ticker(pop, '正在准备上下文');
    try {
      const draft = { text: ctx.text, question, anchor: ctx.anchor, offset: ctx.offset };
      const { id, jobId } = this.beginLookup(draft);
      await this.uploadArticle();
      if (!this.items.some(e => e.id === id && e.extra?.status === 'running')) return;
      if (tk.current && pop.open$) {
        pop.supplement?.(id, this.items.find((e) => e.id === id)?.extra?.supplement || '');
      }
      // 已有作业只附着，不再提交；显示权由 ticker 保证，不覆盖另一个选区。
      if (jobId) {
        tk.label('已在进行中，接着看…');
        await this.followJob(id, jobId, draft, { pop, tk });
      } else {
        tk.label('思考中');
        await this.pollExplain(id, draft, { fresh, pop, tk });
      }
    } catch (e) {
      if (tk.current && pop.open$) pop.body(`解释失败：${e.message}`, 'bad').foot(this.hintFor(e));
    } finally {
      tk.stop();
      if (this.explainSubmissions.get(key) === submission) this.explainSubmissions.delete(key);
      this.syncExplainSubmit(pop);
      if (pop !== this.pops?.explain) this.syncExplainSubmit();
    }
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
      id, urlKey: this.key, url: this.articleUrl, title: this.articleTitle,
      action: 'explain', text, value: prev?.value || null, color: null,
      anchor: anchor ?? prev?.anchor ?? null, parentId: null,
      extra: { ...prev?.extra, question: question || '', status: 'running', offset, error: '', progress: '正在准备上下文…',
        ...(prev?.extra?.supplement ? { supplement: prev.extra.supplement } : {}) },
      createdAt: prev?.createdAt ?? Date.now(),
    };
    this.items = [...this.items.filter((e) => e.id !== id), ev];
    this.persist([ev]);
    this.reanchor();
    // 同一段同一问题若已有作业在跑，调用方应当**附着**上去而不是再提交一次
    const busy = prev && !prev.value && prev.extra?.status === 'running' && prev.extra?.jobId;
    return { id, jobId: busy ? prev.extra.jobId : null };
  }

  /** 更新某条查询记录的状态（进度 / 失败原因），只动本地镜像 */
  patchLookup(id, patch) {
    const ev = this.items.find((e) => e.id === id);
    if (!ev) return null;
    // Answer deltas update an isolated preview; unchanged job metadata must not
    // rewrite the whole reading mirror or rerender every record at token speed.
    if (Object.entries(patch).every(([key, value]) => Object.is(ev.extra?.[key], value))) return ev;
    const durable = (patch.status && patch.status !== ev.extra?.status)
      || (patch.jobId && patch.jobId !== ev.extra?.jobId);
    ev.extra = { ...ev.extra, ...patch };
    if (durable) this.persist([ev]);
    mSet(this.key, this.items);
    this.panel.render();
    return ev;
  }

  /**
   * 发起并跟进一次解释。
   * 浮层可以随时关掉 —— 结果回来时写进记录并刷新面板，不依赖浮层还在不在。
   */
  async pollExplain(id, draft, { fresh = false, pop = null, tk = null } = {}) {
    const live = () => pop && pop.open$ && this.watching === id && tk?.current !== false;
    const ctl = new AbortController();
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.set(id, ctl);
    const alive = () => !ctl.signal.aborted && this.items.some((e) => e.id === id);
    if (tk?.current !== false) this.watching = id;
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
          this.panel.renderLookupPreview?.(id, job.partialAnswer || '');
          if (live()) {
            tk?.label(note);
            if (job.partialAnswer) pop.preview?.(job.partialAnswer, note);
          }
        },
      });
      if (!alive()) { tk?.stop(); return; }       // 删除/abort 后，晚到结果不得复活记录
      const ms = tk?.stop() ?? 0;
      this.saveLookup('explain', {
        text: draft.text, value: r.answer, anchor: draft.anchor,
        extra: { question: r.question || draft.question || '' },
      });
      if (live()) {
        pop.answer(r.answer).foot(this.meta({ ...r, ms })).showRefresh(r.cached === 'local');
      }
    } catch (e) {
      tk?.stop();
      if (ctl.signal.aborted || !this.items.some((x) => x.id === id)) return;
      const status = e.code === 'ABORTED' ? 'canceled' : this.online && e.status ? 'error' : 'deferred';
      this.patchLookup(id, {
        status, error: e.message, progress: status === 'deferred'
          ? '离线，已保存；联网后手动重试' : '',
      });
      if (live()) pop.body(`解释失败：${e.message}`, 'bad').foot(this.hintFor(e));
    } finally {
      tk?.stop();
      if (!this.lookupRuns.has(id) || this.lookupRuns.get(id) === ctl) this.panel.renderLookupPreview?.(id, '');
      if (this.lookupRuns.get(id) === ctl) {
        this.lookupRuns.delete(id);
        if (this.watching === id) this.watching = null;
      }
      this.syncExplainSubmit();
    }
  }

  /**
   * 跟进一个**已存在**的作业（重复点击、或页面刷新后接上）。
   * 与 pollExplain 的区别只有一个：不再 POST，避免为同一个问题排两个作业。
   */
  async followJob(id, jobId, draft, { pop = null, tk = null } = {}) {
    const live = () => pop && pop.open$ && this.watching === id && tk?.current !== false;
    const ctl = new AbortController();
    this.lookupRuns.get(id)?.abort();
    this.lookupRuns.set(id, ctl);
    const alive = () => !ctl.signal.aborted && this.items.some((e) => e.id === id);
    if (tk?.current !== false) this.watching = id;
    try {
      // Replacing a viewer of the same job only detaches the old subscription.
      // Explicit Cancel/Delete actions send their own server-side cancellation.
      const result = await api.waitForJob(jobId, { signal: ctl.signal, cancelOnAbort: false, onProgress: (job) => {
        if (!alive()) return;
        const note = job.queuedAhead ? `排队中（前面 ${job.queuedAhead} 个）` : (job.progress || '本地 agent 思考中');
        this.patchLookup(id, { status: 'running', progress: note, jobId });
        this.panel.renderLookupPreview?.(id, job.partialAnswer || '');
        if (live()) { tk?.label(note); if (job.partialAnswer) pop.preview?.(job.partialAnswer, note); }
      } });
      if (!alive()) return;
      const ms = tk?.stop() ?? 0;
      this.saveLookup('explain', { text: draft.text, value: result.answer, anchor: draft.anchor,
        extra: { question: draft.question || '' } });
      if (live()) pop.answer(result.answer).foot(this.meta({ ...result, ms }));
    } catch (e) {
      tk?.stop();
      if (ctl.signal.aborted || !this.items.some((x) => x.id === id)) return;
      const status = e.code === 'ABORTED' ? 'canceled' : this.online && e.status ? 'error' : 'deferred';
      this.patchLookup(id, { status, error: e.message,
        progress: status === 'deferred' ? '离线，已保存；联网后手动重试' : '' });
      if (live()) pop.body(`解释失败：${e.message}`, 'bad').foot(this.hintFor(e));
    } finally {
      tk?.stop();
      if (!this.lookupRuns.has(id) || this.lookupRuns.get(id) === ctl) this.panel.renderLookupPreview?.(id, '');
      if (this.lookupRuns.get(id) === ctl) {
        this.lookupRuns.delete(id);
        if (this.watching === id) this.watching = null;
      }
      this.syncExplainSubmit();
    }
  }

  /**
   * 速览：打开只回看已有结果；明确点击生成才发送正文并调用 AI。
   *
   * **每篇只做一次。** 结果落库（action='summary'，id 由 urlKey 派生），
   * 再打开同一篇直接读缓存。走 agent 时一次要几十秒且花钱，所以绝不能每次
   * 展开面板都重跑 —— this.briefBusy 挡住同一页内的重复触发，服务端的本地缓存
   * 挡住跨页面/跨会话的重复。
   *
   * @param {boolean} [fresh] 点「重新生成」时跳过缓存
   */
  async autoSummarize(fresh = false) {
    if (fresh && !this.isCurrentArticle()) return;
    if (this.briefBusy) return;
    const has = this.items.find((e) => e.action === 'summary' && !e.deletedAt && e.value);
    if (has && !fresh) {
      this.panel.renderBrief({ state: 'ok', text: has.value, retry: true });
      return;
    }
    // 展开侧栏只是查看记录，不代表同意上传正文或调用付费模型。
    // 只有明确点击「生成速览 / 重新生成」才继续下面的网络路径。
    if (!fresh) {
      this.panel.renderBrief(this.serviceInfo?.explainConfigured === false
        ? { state: 'idle', text: 'AI 尚未配置，可先写批注与自己的笔记。需要时再配置模型或 Agent。', configure: true }
        : { state: 'idle', text: '按需生成文章要点。生成时会发送正文给你配置的模型或 Agent，可能产生费用。', retry: true, initial: true });
      return;
    }
    if (this.openConnectionSettings && !this.online) {
      this.panel.renderBrief({ state: 'idle', text: 'AI 速览需连接本地服务。你可以先写批注和自己的总结，随时复制或下载。' });
      return;
    }
    if (this.serviceInfo?.explainConfigured === false) {
      if (fresh) {
        try { this.serviceInfo = await api.health(); } catch { /* normal request reports connectivity */ }
      }
      if (this.serviceInfo?.explainConfigured === false) {
        this.panel.renderBrief({ state: 'idle', text: '本地服务已连接。配置模型或本地 Agent 后可以生成 AI 速览；现在可直接批注和同步笔记。', configure: true });
        return;
      }
    }
    const deferred = this.items.find((e) => e.action === 'summary' && !e.deletedAt
      && e.extra?.status === 'deferred');
    if (deferred && !fresh) {
      this.panel.renderBrief({ state: 'err', text: '离线，速览请求已保存；联网后可手动重试', retry: true });
      return;
    }
    // 正文太短的页面不值得总结（搜索结果页、仓库首页、列表页）
    const text = this.index?.text || '';
    if (text.length < 200) { this.panel.renderBrief({ state: 'idle', text: '页面正文太短或尚未加载，请等待内容加载后再生成。', retry: true, initial: true }); return; }

    this.briefBusy = true;
    const controller = new AbortController();
    this.briefController = controller;
    const t0 = performance.now();
    this.panel.renderBrief({ state: 'run', text: '正在生成速览…', previous: has?.value });
    try {
      await this.uploadArticle();
      if (controller.signal.aborted) return;
      const r = await api.summarize({
        urlKey: this.key, fresh, signal: controller.signal,
        onProgress: (job) => { if (!controller.signal.aborted) { this.briefJobId = job.id; this.panel.renderBrief({
          state: 'run',
          text: job.queuedAhead ? `排队中（前面 ${job.queuedAhead} 个）`
            : (job.progress || '正在生成速览…'),
          partialAnswer: job.partialAnswer,
        }); } },
      });
      if (controller.signal.aborted || this.stopped) return;
      const ms = (performance.now() - t0).toFixed(0);
      // 落库：速览要作为这条对话的第一轮，后面的解释才接得上
      this.saveLookup('summary', { text: '', value: r.summary, anchor: null, extra: {} });
      this.panel.renderBrief({
        state: 'ok', text: r.summary, retry: true,
        meta: [this.meta({ ...r, ms }), r.degraded].filter(Boolean).join(' · '),
      });
    } catch (e) {
      if (controller.signal.aborted || this.stopped) return;
      if (!has && (!this.online || !e.status)) {
        this.saveLookup('summary', { text: '', value: null, anchor: null,
          extra: { status: 'deferred', error: e.message } });
      }
      this.panel.renderBrief({
        state: has ? 'ok' : 'err', retry: true,
        text: has?.value || `速览失败：${e.message}`,
        meta: has ? `重新生成失败，保留原速览：${e.message}` : this.hintFor(e),
      });
    } finally {
      if (this.briefController === controller) {
        this.briefBusy = false;
        this.briefController = null; this.briefJobId = null;
      }
    }
  }

  cancelSummary() {
    if (!this.briefBusy) return;
    this.briefController?.abort();
    if (this.briefJobId) api.cancelJob(this.briefJobId);
    this.briefBusy = false; this.briefController = null; this.briefJobId = null;
    const previous = this.items.find(e => e.action === 'summary' && e.value && !e.deletedAt);
    this.panel.renderBrief(previous
      ? { state: 'ok', text: previous.value, retry: true, meta: '已取消重新生成，保留原速览' }
      : { state: 'idle', text: '已取消。需要时可重新生成。', retry: true, initial: true });
  }

  /** 面板上点「重试」；deferred 永远由用户手动触发，不在重连时自动消费。 */
  async retryLookup(id) {
    if (!this.isCurrentArticle()) return;
    const ev = this.items.find((e) => e.id === id);
    if (!ev || this.lookupRuns.has(id)) return;
    if (ev.action === 'translate') {
      const controller = new AbortController();
      this.lookupRuns.set(id, controller);
      const alive = () => !controller.signal.aborted && this.items.some(e => e.id === id);
      this.patchLookup(id, { status: 'running', progress: '重新提交…', error: '' });
      try {
        await this.uploadArticle();
        if (!alive()) return;
        const r = await api.translate(ev.text, ev.extra?.target, this.key, ev.extra?.offset);
        if (!alive()) return;
        this.saveLookup('translate', { text: ev.text, value: r.translation, anchor: ev.anchor,
          extra: { target: r.target || ev.extra?.target || '' } });
      } catch (e) {
        if (!alive()) return;
        const status = this.online && e.status ? 'error' : 'deferred';
        this.patchLookup(id, { status, error: e.message,
          progress: status === 'deferred' ? '离线，已保存；联网后手动重试' : '' });
      } finally { if (this.lookupRuns.get(id) === controller) this.lookupRuns.delete(id); }
      return;
    }
    this.patchLookup(id, { status: 'running', progress: '重新提交…', error: '' });
    await this.pollExplain(id, {
      text: ev.text, question: ev.extra?.question || '',
      anchor: ev.anchor, offset: ev.extra?.offset,
    }, { fresh: true });
  }

  markdown() {
    return renderArticleMarkdown({ title: this.articleTitle, url: this.articleUrl, events: this.items });
  }

  async portableMarkdown() {
    const text = await inlineAssetTokens(this.markdown(), async (id) => {
      const local = await getOfflineAsset(id);
      if (local) return local;
      if (!this.online) return null;
      try { return await api.fetchAsset(id); } catch { return null; }
    });
    if (assetIds(text).length) throw new Error('有图片附件暂不可用，请联网后重试或使用笔记同步');
    return text;
  }

  async copyMarkdown() {
    const text = await this.portableMarkdown();
    await this.copyText(text);
    return 'Markdown 已复制';
  }

  async copyText(text) {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      if (!document.execCommand?.('copy')) throw new Error('浏览器不允许复制，请使用下载');
      ta.remove();
    }
  }

  async downloadMarkdown() {
    const blob = new Blob([await this.portableMarkdown()], { type: 'text/markdown;charset=utf-8' });
    const href = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = href; a.download = safeMarkdownFilename(this.articleTitle, this.key);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
    return 'Markdown 已下载';
  }

  /**
   * 页面加载后接上未完成的解释。
   *
   * 作业只活在服务端内存里，页面一刷新轮询就断了。若不管，那条记录会永远显示
   * "进行中"。这里逐条查一次：还在跑就接着跟，已完成就写回结果，查不到就标成
   * 中断并给重试 —— 三种下场都比"永远转圈"好。
   */
  async resumePending() {
    const pend = this.items.filter((e) => e.action === 'explain' && !e.deletedAt
      && e.extra?.status === 'running');
    for (const ev of pend) {
      if (this.lookupRuns.has(ev.id) || this.explainSubmissions.has(lookupKey(ev))) continue;
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
        } else if (job.status === 'error' || job.status === 'canceled') {
          this.patchLookup(ev.id, { status: job.status === 'canceled' ? 'canceled' : 'error', error: job.error?.message || '作业已结束' });
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

  meta({ cached, model, truncated, thinking, ctx, via }) {
    // 默认界面只保留会影响用户判断/操作的信息；token、耗时、cache read、
    // 会话续接和 Agent 成本仍在服务端结果与日志里，不再把回答区做成调试控制台。
    if (cached === 'local') {
      const when = ctx?.cachedAt ? new Date(ctx.cachedAt).toLocaleString('zh-CN', { hour12: false }) : '';
      return `本地已有答案${when ? ` · ${when}` : ''}`;
    }
    if (cached) return '缓存命中';
    return [
      via?.startsWith('agent') ? `${model}（本地 Agent）` : model,
      ctx?.articleTruncated ? '⚠ 正文过长，仅使用前 400k 字符' : null,
      ctx?.truncated ? '⚠ 上下文已截断' : null,
      ctx?.dropped ? `⚠ 已省略 ${ctx.dropped} 轮较早记录` : null,
      thinking === 'unsupported' ? '⚠ 当前模型不支持 think，已自动关闭' : null,
      truncated ? '⚠ 回答可能不完整' : null,
    ].filter(Boolean).join(' · ');
  }

  hintFor(e) {
    if (e.code === 'PAIRING_REQUIRED') return '在侧栏点击「开启 AI / 同步」完成连接。批注、复制和下载无需连接。';
    if (e.code === 'NO_FILE_TARGET') return '打开“配置”并选择 Obsidian Vault 或 Markdown 文件夹';
    if (e.code === 'FS_PERMISSION') return '打开“配置”并点击重新授权';
    if (e.code === 'FS_UNSUPPORTED') return '当前浏览器不支持文件夹写入，可使用底部“下载”';
    if (e.code === 'LLM_BRIDGE_UNAVAILABLE') return '请在支持 AI 能力的 浏览器 userscript环境中运行';
    if (e.code === 'LLM_BRIDGE_TIMEOUT') return '本次等待已结束；晚到结果不会写入，可稍后手动重试';
    if (['LLM_BRIDGE_ERROR', 'LLM_BRIDGE_BAD_RESPONSE'].includes(e.code)) return '浏览器 AI 暂时不可用，请稍后手动重试';
    if (e.code === 'NO_AGENT') return '在面板「配置」里选一个本地 agent 并点「检测」';
    if (e.code === 'AGENT_SPAWN') return '选中的 agent 没装或不在 PATH 上';
    if (e.code === 'AGENT_TIMEOUT') return 'agent 太久没返回；可在配置里调大超时或改用 LLM';
    if (e.code === 'AGENT_AUTH') return '请在终端打开 Claude Code 并运行 /login，登录后点击上方重试';
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
    if (prev?.extra?.supplement) extra = { ...(extra || {}), supplement: prev.extra.supplement };
    const history = [...(prev?.extra?.history || [])];
    if (prev?.value && value && prev.value !== value) history.push({ value: prev.value, at: prev.updatedAt || prev.createdAt });
    if (history.length) extra = { ...extra, history: history.slice(-5) };

    const ev = {
      id: prev?.id ?? lookupId(this.key, draft),
      urlKey: this.key, url: this.articleUrl, title: this.articleTitle,
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
 * 脚本可能被注入两次（userscript再次点击；扩展重载后旧 content script 仍在）。直接再建
 * shadowHost 会产生两套完整 UI，所以仍用 documentElement 标记做闸。区别是：公开userscript
 * 把“再次执行”解释为切换已有面板，通过固定 DOM 事件通知第一份实例；扩展等普通
 * 入口仍忽略重复注入。
 */
const MARK = 'contextflowLoaded';
const TOGGLE_MARK = 'toggle';
const PANEL_TOGGLE_EVENT = 'contextflow:toggle-panel';

/**
 * 显式启动，**不在模块加载时自动跑**。
 *
 * 两个载体都要在启动前先把传输层配好（扩展入口要 setTransport 换成走 service worker），
 * 若在 import 时就自动启动，那一步永远来不及。
 *
 * @param {{initialPanelOpen?: boolean|null, toggleExisting?: boolean}} options
 * @returns {App|null} 首次启动返回实例；已有实例时返回 null
 */
export function boot({ initialPanelOpen = null, toggleExisting = false } = {}) {
  // 停用名单优先于一切：不建 UI、不订阅、不上传正文，页面上不留任何痕迹。
  const blocked = blockedScope();
  if (blocked) {
    // 首次执行（通常是页面加载）保持绝对安静 —— 否则停用本身就成了新的打扰。
    // userscript载体的「重复执行」是用户主动敲门，这时才弹恢复卡片；
    // 扩展载体的恢复入口在 ext/app.js（点工具栏图标）。
    const loaded = document.documentElement.dataset[MARK];
    if (toggleExisting && loaded === TOGGLE_MARK) {
      showUnblockChip(blocked);
      return null;
    }
    document.documentElement.dataset[MARK] = toggleExisting ? TOGGLE_MARK : '1';
    console.log(`[ContextFlow] 此${blocked === 'site' ? '站点' : '页面'}在停用名单中，未启动`);
    return null;
  }
  const loaded = document.documentElement.dataset[MARK];
  if (loaded) {
    if (toggleExisting && loaded === TOGGLE_MARK) {
      document.dispatchEvent(new Event(PANEL_TOGGLE_EVENT));
      return null;
    }
    console.warn('[ContextFlow] 本页已在运行，忽略这次重复注入'
      + '（重复注入会产生两套 UI，点击可能落到不可见的那一套上）。刷新页面可重置。');
    return null;
  }
  document.documentElement.dataset[MARK] = toggleExisting ? TOGGLE_MARK : '1';
  let navigationNotice;
  const clearNavigationNotice = () => { releaseThemeHost(navigationNotice); navigationNotice?.host?.remove(); navigationNotice = null; };
  const app = articleSession({
    create: options => new App(options || { initialPanelOpen }), keyOf: urlKey,
    href: () => location.href,
    onTransition: clearNavigationNotice,
    onError: (error, retry, previous, phase) => {
      const startup = phase === 'startup';
      console.warn('[ContextFlow] 阅读记录暂不可用：', error.message);
      if (!document.body) return;
      navigationNotice ??= shadowHost('article-transition', `${FLOAT}.notice{position:fixed;top:14px;left:50%;transform:translateX(-50%);width:min(480px,calc(100vw - 28px));padding:15px;background:${T.paper};color:${T.ink};font:13px/1.6 ${T.sans};border:1px solid ${T.line};border-left:3px solid ${T.bad};border-radius:${T.radius};box-shadow:${T.shadowFloat}}.notice p{margin:7px 0 12px}.actions{display:flex;gap:8px;flex-wrap:wrap}.actions button{border:1px solid ${T.line};background:${T.paperRaised}}`, 2147483647);
      if (!navigationNotice.getElementById('route-notice')) navigationNotice.innerHTML += '<section class="notice" id="route-notice" role="alert"><strong>上一页草稿尚未安全保存</strong><p></p><div class="actions"><button type="button" id="route-retry">重试保存并切换</button><button type="button" id="route-copy">复制上一页记录</button></div></section>';
      navigationNotice.querySelector('strong').textContent = startup ? '暂时无法打开本地阅读记录' : '上一页草稿尚未安全保存';
      navigationNotice.querySelector('p').textContent = startup ? '本地存储暂不可用，现有记录已保留。请重试；持续失败时，可在扩展设置的「帮助与诊断」中检查。' : `${error.message}。记录仍属于上一页；保存成功后再切换，不会写入当前文章。`;
      navigationNotice.getElementById('route-retry').textContent = startup ? '重试打开' : '重试保存并切换';
      navigationNotice.getElementById('route-copy').hidden = startup;
      navigationNotice.getElementById('route-retry').onclick = () => retry();
      navigationNotice.getElementById('route-copy').onclick = async () => {
        try { await previous.copyMarkdown(); navigationNotice.querySelector('strong').textContent = '上一页记录已复制，请妥善保留'; }
        catch (copyError) { navigationNotice.querySelector('p').textContent = copyError.message; }
      };
    },
  });
  if (toggleExisting) {
    document.addEventListener(PANEL_TOGGLE_EVENT, () => app.togglePanel());
  }
  // start 是异步的（要对账、上传正文），但调用方需要立刻拿到实例
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.start(), { once: true });
  } else {
    app.start();
  }
  return app;
}
