// 右侧停靠面板：翻译 / 解释 / 批注 / 总结 四个 tab（顺序见 TABS）。
//
// 注：浏览器自带的侧栏属于 browser chrome，页面 JS 无法注入。
// 这里做的是页面内右侧停靠层。
//
// 两种布局模式（可切换、记忆）：
//   push  —— 给 <html> 加 margin-right，把正文挤到左边，与面板完全不重叠。默认。
//   float —— 浮在正文之上。用于 push 会破坏布局的站点（见 setMode 注释）。
// 宽度可拖左缘调整，写入 localStorage。
//
// 四个 tab 的条目一律按「文档中的位置」排序，而不是创建时间 —— 读者的心理模型是
// 「从上往下读」，按时间排会让同一段的记录散落在列表各处，回看时对不上原文。

import { T, shadowHost } from './theme.js';
import { MARKS } from '../core/highlight.js';
import { byPosition } from '../core/order.js';
import { Settings, SETTINGS_CSS } from './settings.js';

// tab 的顺序、内部键、显示名集中在这里 —— 此前散落在 HTML、select()、
// toggleSettings() 和四个 onclick 里，改一次顺序要同步改四处。
//
// key 是**内部键，不能改**：'note' 同时是事件的 action 名和 id 前缀
// （note:<urlKey>），server/mdfile.mjs、siyuan.mjs 都按它匹配。
// 显示名改成「总结」只动 label。
const TABS = [
  { key: 'translate', label: '翻译' },
  { key: 'explain', label: '解释' },
  { key: 'comments', label: '批注' },
  { key: 'note', label: '总结' },
];
const TAB_KEYS = TABS.map((t) => t.key);

const UI_KEY = 'contextflow:ui';
const MIN_W = 260;
const MAX_FRAC = 0.6;          // 最宽不超过视口 60%

const loadUI = () => {
  try { return { width: 360, mode: 'push', open: false, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; }
  catch { return { width: 360, mode: 'push', open: false }; }
};
const saveUI = (ui) => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* 配额 */ } };

const PANEL_CSS = `
  .wrap{position:fixed;top:0;right:0;height:100vh;
        background:${T.paper};border-left:1px solid ${T.line};
        font:13px/1.6 ${T.sans};color:${T.ink};
        display:none;flex-direction:column;overflow:hidden}
  .wrap.open{display:flex}
  .wrap.float{box-shadow:-10px 0 30px -14px rgba(28,26,23,.22)}

  /* 左缘拖拽把手 */
  .grab{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:col-resize;
        z-index:2;background:transparent}
  .grab::after{content:'';position:absolute;left:2px;top:0;bottom:0;width:2px;
        background:transparent;transition:background .12s}
  .grab:hover::after,.grab.on::after{background:${T.accent}}

  header{padding:12px 14px 0;flex:0 0 auto}
  .title{display:flex;align-items:center;justify-content:space-between;gap:6px}
  .brand{display:flex;align-items:center;gap:6px;
         font-weight:600;letter-spacing:.01em;font-size:12.5px;color:${T.inkSoft}}
  .brand em{font-style:normal;color:${T.accent}}
  .mk{width:15px;height:15px;flex:0 0 auto}
  .title .r{gap:2px}
  .title button{font-size:11.5px;padding:4px 7px}

  .tabs{display:flex;gap:1px;margin:10px -4px 0;padding:0 4px;
        border-bottom:1px solid ${T.line};overflow-x:auto;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:7px 8px;border-radius:7px 7px 0 0;color:${T.quote};
       font-size:12.5px;position:relative;top:1px;border:1px solid transparent;
       border-bottom:none;background:none}
  .tab:hover{color:${T.ink};background:${T.sunk}}
  .tab[aria-selected=true]{color:${T.ink};background:${T.paper};
       border-color:${T.line};font-weight:600}
  .badge{display:inline-block;min-width:16px;padding:0 4px;margin-left:5px;
         border-radius:8px;background:${T.sunk};color:${T.quote};
         font-size:10.5px;line-height:16px;text-align:center;font-weight:600}

  .body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:12px 14px 20px}
  .pane{display:none} .pane.on{display:block}

  /* ---- 批注条目：浅色衬线原文 + 底部划线 + 黑字评论 ---- */
  .item{padding:12px 0;border-bottom:1px solid ${T.lineSoft}}
  .item:last-child{border-bottom:none}
  .src{font:italic 13px/1.62 ${T.serif};color:${T.quote};
       border-bottom:1px solid ${T.line};padding-bottom:8px;cursor:pointer;
       display:block;transition:color .12s;overflow-wrap:anywhere}
  .src:hover{color:${T.inkSoft}}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;
       margin-right:6px;vertical-align:1px}
  .cmt{width:100%;margin-top:8px;border:none;outline:none;resize:none;
       background:transparent;font:13px/1.62 ${T.sans};color:${T.ink};
       padding:0;overflow:hidden;min-height:1.62em;display:block;overflow-wrap:anywhere}
  .cmt::placeholder{color:#c3bdb0}
  .tools{display:flex;justify-content:flex-end;gap:2px;margin-top:4px;
         opacity:0;transition:opacity .12s}
  .item:hover .tools,.item:focus-within .tools{opacity:1}
  .tools button{font-size:11.5px;padding:3px 7px}

  .empty{color:${T.quote};font-size:12.5px;padding:28px 4px;text-align:center;line-height:1.8}

  /* ---- 解释 / 翻译 记录 ---- */
  .src.lk{border-bottom:1px solid ${T.line};padding-bottom:7px}
  /* 条目下划线与正文标记同色同线型 —— 两边一眼能认出是同一条 */
${Object.entries(MARKS).map(([k, m]) =>
    `  .item.k-${k} .src.lk{border-bottom-style:${m.line};border-bottom-color:${m.color}}`).join('\n')}
  /* 失锚：原文找不回来了，别给出可点的假象 */
  .src.off{cursor:default;opacity:.72;border-bottom-style:solid;border-bottom-color:${T.lineSoft}}
  .src.off:hover{color:${T.quote}}
  /* 从正文跳进来时短暂标出，帮眼睛在列表里落点 */
  .item.hit{background:rgba(180,83,9,.10);border-radius:8px;
            box-shadow:0 0 0 8px rgba(180,83,9,.10)}
  .q2{margin-top:7px;font-size:12.5px;font-weight:600;color:${T.accent}}
  /* 进行中 / 失败的状态行。提交即落记录，所以列表里会出现还没有答案的条目 —— */
  /* 得让人看出它在跑、跑到哪、还是已经失败了。 */
  .st{margin-top:6px;font-size:12px;display:flex;align-items:center;gap:6px}
  .st.run{color:${T.quote}}
  .st.err{color:#b3261e}
  .st .dot2{width:6px;height:6px;border-radius:50%;background:${T.accent};flex:0 0 auto;
            animation:cfpulse 1.1s ease-in-out infinite}
  @keyframes cfpulse{0%,100%{opacity:.25}50%{opacity:1}}
  .st button{border:1px solid ${T.line};background:${T.sunk};padding:2px 7px;font-size:11px}
  .st button:hover{background:#ece7dd}
  .item.pend .src.lk{border-bottom-style:dotted;border-bottom-color:${T.line}}
  .ans{margin-top:6px;font:13px/1.62 ${T.sans};color:${T.ink};
       white-space:pre-wrap;overflow-wrap:anywhere}
  .tools .muted{margin-right:auto;font-variant-numeric:tabular-nums}

  /* ---- 总结 ---- */
  .note{width:100%;height:calc(100vh - 190px);border:1px solid ${T.line};
        border-radius:${T.radius};background:${T.paper};padding:11px 12px;
        font:13.5px/1.75 ${T.sans};color:${T.ink};resize:none;outline:none}
  .note:focus{border-color:#d7cfbe;box-shadow:0 0 0 3px rgba(180,83,9,.07)}

  footer{flex:0 0 auto;padding:8px 14px;border-top:1px solid ${T.line};
         background:${T.sunk};font-variant-numeric:tabular-nums}
  footer .r{justify-content:space-between;gap:8px}
  footer .muted{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 同步结果/失败原因。原先只写进 console，界面上只有"同步失败"三个字，
     等于把唯一有用的信息藏在开发者工具里。 */
  .syncmsg{display:none;margin-top:6px;font-size:11.5px;line-height:1.5;
           overflow-wrap:anywhere}
  .syncmsg.on{display:block}
  .syncmsg.bad{color:#b3261e}
  .syncmsg.ok{color:${T.quote}}
  .syncmsg .hint{color:${T.quote};display:block;margin-top:2px}

  /* ---- 收起时的右缘把手 ---- */
  .grip{position:fixed;right:0;top:46%;display:flex;align-items:center;gap:6px;
        writing-mode:vertical-rl;padding:12px 6px;cursor:pointer;
        background:${T.paper};color:${T.inkSoft};border:1px solid ${T.line};
        border-right:none;border-radius:8px 0 0 8px;font:11.5px/1 ${T.sans};
        letter-spacing:.08em;box-shadow:-2px 0 10px -4px rgba(28,26,23,.2)}
  /* 竖排把手里的图标要强制横排，否则会随文字一起旋转 */
  .grip .mk{writing-mode:horizontal-tb;width:14px;height:14px;margin-bottom:2px}
  .grip:hover{color:${T.ink}}
  .grip.hide{display:none}
${SETTINGS_CSS}
`;

/**
 * 把服务端的错误翻成"下一步该做什么"。
 * 这些都是实际踩过的：改完代码忘了重启服务，界面上只有"同步失败"三个字。
 */
function hintFor(msg) {
  const m = String(msg || '');
  if (/无此路由/.test(m)) return '本地服务还是旧版本，重启它：npm run server';
  if (/未配置/.test(m)) return '点上方「配置」补上目标目录或 token';
  if (/连不上思源|SIYUAN_DOWN|思源没开/.test(m)) return '思源没开？启动后再试';
  if (/token 无效/.test(m)) return '在「配置」里重填思源 API token';
  if (/越出根目录/.test(m)) return '「配置」里的子目录写了 ../，改掉';
  if (/Failed to fetch|NetworkError|服务不可达/.test(m)) return '本地服务没在跑：npm run server';
  return '';
}

export class Panel {
  /** @param {object} h 回调集合，见 main.js handlers() */
  constructor(h) {
    this.h = h;
    this.ui = loadUI();
    // 默认停在「批注」而不是最左的「翻译」：那里放的是你自己写的东西。
    // tab 顺序按使用频率排（翻译最勤），落点按内容价值排 —— 两者不必一致。
    this.tab = 'comments';
    this.open = false;
    this.rootMarginBefore = null;

    const sh = shadowHost('panel', PANEL_CSS);
    sh.innerHTML += `
      <div class="grip" id="grip"><svg class="mk" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h12" stroke="currentColor" stroke-opacity=".34" stroke-width="2.2" stroke-linecap="round"/><path d="M4 17.5h9" stroke="currentColor" stroke-opacity=".34" stroke-width="2.2" stroke-linecap="round"/><path d="M4 12h13.5" stroke="${T.accent}" stroke-width="2.6" stroke-linecap="round"/><path d="M16.3 9.2 19.8 12l-3.5 2.8" stroke="${T.accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>ContextFlow <span id="gn"></span></div>
      <div class="wrap" id="wrap">
        <div class="grab" id="grab" title="拖动调整宽度"></div>
        <header>
          <div class="title">
            <span class="brand"><svg class="mk" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h12" stroke="currentColor" stroke-opacity=".34" stroke-width="2.2" stroke-linecap="round"/><path d="M4 17.5h9" stroke="currentColor" stroke-opacity=".34" stroke-width="2.2" stroke-linecap="round"/><path d="M4 12h13.5" stroke="${T.accent}" stroke-width="2.6" stroke-linecap="round"/><path d="M16.3 9.2 19.8 12l-3.5 2.8" stroke="${T.accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Context<em>Flow</em></span>
            <span class="r">
              <button id="cfg" title="配置翻译后端与思源目录">配置</button>
              <button id="mode" title="切换：挤开正文 / 浮在正文上"></button>
              <button id="close" title="收起">收起 ›</button>
            </span>
          </div>
          <div class="tabs" role="tablist">
            ${TABS.map((t) => `<button class="tab" id="t-${t.key}" role="tab">${t.label}`
              + `<span class="badge" id="b-${t.key}">${t.key === 'note' ? '' : '0'}</span></button>`).join('')}
          </div>
        </header>
        <div class="body">
          ${TABS.map((t) => `<div class="pane" id="p-${t.key}">${t.key === 'note'
            ? '<textarea class="note" id="note"'
              + ' placeholder="这篇文章的整体理解、与其他工作的关系、待验证的问题…"></textarea>'
            : ''}</div>`).join('')}
          <div class="set" id="p-set"></div>
        </div>
        <footer>
          <div class="r">
            <span id="stat" title="点击重新解析锚点"></span>
            <button id="sync" title="把四类记录同步到笔记库">同步到笔记</button>
          </div>
          <div class="syncmsg" id="syncmsg"></div>
        </footer>
      </div>`;
    this.sh = sh;
    this.$ = (id) => sh.getElementById(id);

    this.$('grip').onclick = () => this.toggle(true);
    this.$('close').onclick = () => this.toggle(false);
    // 「重锚」按钮已移除；能力保留在统计文字上 —— 动态内容加载后偶尔需要手动触发
    this.$('stat').style.cursor = 'pointer';
    this.$('stat').onclick = () => this.h.onReanchor();
    this.$('sync').onclick = () => this.doSync();
    this.$('cfg').onclick = () => this.toggleSettings();
    this.$('mode').onclick = () => this.setMode(this.ui.mode === 'push' ? 'float' : 'push');
    for (const k of TAB_KEYS) this.$(`t-${k}`).onclick = () => this.select(k);

    const note = this.$('note');
    let nt = null;
    note.addEventListener('input', () => {
      clearTimeout(nt);
      nt = setTimeout(() => this.h.onNoteChange(note.value), 600);   // 防抖自动保存
    });

    this.wireResize();
    addEventListener('resize', () => this.applyLayout());
    this.select('comments');
    this.applyLayout();
    if (this.ui.open) this.toggle(true);
  }

  /** 配置界面与四个 tab 互斥显示 */
  toggleSettings() {
    const on = !this.settingsOpen;
    this.settingsOpen = on;
    this.toggle(true);
    this.$('p-set').classList.toggle('on', on);
    this.$('cfg').textContent = on ? '‹ 返回' : '配置';
    for (const k of TAB_KEYS) this.$(`p-${k}`).classList.toggle('on', !on && this.tab === k);
    this.sh.querySelector('.tabs').style.display = on ? 'none' : 'flex';
    if (on) {
      if (!this.settings) this.settings = new Settings(this.sh, this.$('p-set'), this.h.api);
      this.settings.load();
    }
  }

  async doSync() {
    const btn = this.$('sync');
    const old = btn.textContent;
    btn.textContent = '同步中…';
    this.syncMsg('');
    try {
      const r = await this.h.onSync();
      // 新增与改写要分开报：只报总数的话，"改了总结再同步"看起来像什么都没发生
      const bits = [r.inserted ? `新增 ${r.inserted}` : null,
        r.updated ? `改写 ${r.updated}` : null].filter(Boolean);
      btn.textContent = bits.length ? `已同步 · ${bits.join(' · ')}` : '已是最新';
      const where = (r.files || r.docs || []).join('、');
      if (bits.length && where) this.syncMsg(`${r.articles} 篇 → ${where}`, 'ok');
    } catch (e) {
      btn.textContent = '同步失败';
      // 原因必须出现在界面上。只 console.error 的话，用户看到的是一个
      // 没有下文的"同步失败"，连"服务没重启"这种一句话就能解决的问题都看不出来。
      this.syncMsg(e.message, 'bad', hintFor(e.message));
      console.error('[ContextFlow] 同步到笔记失败：', e.message);
    }
    setTimeout(() => { btn.textContent = old; }, 2600);
  }

  /** @param {string} text 空字符串则隐藏 */
  syncMsg(text, kind = '', hint = '') {
    const el = this.$('syncmsg');
    if (!el) return;
    el.className = `syncmsg${text ? ` on ${kind}` : ''}`;
    el.innerHTML = text
      ? esc(text) + (hint ? `<span class="hint">${esc(hint)}</span>` : '')
      : '';
    el.title = text || '';
  }

  // ---------- 布局 ----------
  clampWidth(w) {
    return Math.round(Math.max(MIN_W, Math.min(w, innerWidth * MAX_FRAC)));
  }

  /**
   * push 模式给 <html> 加 margin-right，使正文与面板完全不重叠。
   * 注意：position:fixed 的页面元素相对视口定位，不随根元素外边距移动，
   * 因此固定顶栏仍可能被面板压住一角 —— 这是页面内注入方案的固有限制，
   * 真正无损的做法只有浏览器级 side panel（迁到扩展后可用 sidePanel API）。
   * 遇到 push 会搞坏布局的站点，切到 float 模式。
   */
  applyLayout() {
    const w = this.clampWidth(this.ui.width);
    this.ui.width = w;
    const wrap = this.$('wrap');
    wrap.style.width = `${w}px`;
    wrap.classList.toggle('float', this.ui.mode === 'float');

    const root = document.documentElement;
    if (this.open && this.ui.mode === 'push') {
      if (this.rootMarginBefore === null) this.rootMarginBefore = root.style.marginRight;
      root.style.marginRight = `${w}px`;
    } else if (this.rootMarginBefore !== null) {
      root.style.marginRight = this.rootMarginBefore;
      this.rootMarginBefore = null;
    }
    this.$('mode').textContent = this.ui.mode === 'push' ? '挤开正文' : '浮层';
  }

  setMode(mode) {
    this.ui.mode = mode;
    // 先还原旧模式留下的外边距，再按新模式重算
    if (this.rootMarginBefore !== null) {
      document.documentElement.style.marginRight = this.rootMarginBefore;
      this.rootMarginBefore = null;
    }
    this.applyLayout();
    saveUI(this.ui);
  }

  wireResize() {
    const grab = this.$('grab');
    let startX = 0, startW = 0;
    const onMove = (e) => {
      // 往左拖变宽：面板贴右缘，所以用 startX - clientX
      this.ui.width = this.clampWidth(startW + (startX - e.clientX));
      this.applyLayout();
    };
    const onUp = (e) => {
      grab.classList.remove('on');
      grab.releasePointerCapture?.(e.pointerId);
      grab.removeEventListener('pointermove', onMove);
      document.documentElement.style.userSelect = '';
      saveUI(this.ui);
    };
    grab.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX; startW = this.ui.width;
      grab.classList.add('on');
      grab.setPointerCapture?.(e.pointerId);
      // 拖动时禁选，否则会在正文里拉出选区并弹出工具条
      document.documentElement.style.userSelect = 'none';
      grab.addEventListener('pointermove', onMove);
      grab.addEventListener('pointerup', onUp, { once: true });
      grab.addEventListener('pointercancel', onUp, { once: true });
    });
    grab.addEventListener('dblclick', () => {           // 双击复位
      this.ui.width = 360; this.applyLayout(); saveUI(this.ui);
    });
  }

  toggle(open = !this.open) {
    this.open = open;
    this.ui.open = open;
    this.$('wrap').classList.toggle('open', open);
    this.$('grip').classList.toggle('hide', open);
    this.applyLayout();
    saveUI(this.ui);
    if (open) this.render();
  }

  select(tab) {
    this.tab = tab;
    if (this.settingsOpen) this.toggleSettings();     // 切 tab 即退出配置界面
    for (const k of TAB_KEYS) {
      this.$(`t-${k}`).setAttribute('aria-selected', String(k === tab));
      this.$(`p-${k}`).classList.toggle('on', k === tab);
    }
    if (tab === 'note') this.$('note').value = this.h.getNote() ?? '';
    else this.render();
  }

  /** 定位到某条批注并聚焦其评论框 */
  focusItem(id) {
    this.toggle(true);
    this.select('comments');
    const el = this.sh.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.querySelector('.cmt')?.focus();
  }

  /**
   * 从正文的解释/翻译标记跳进来。
   * 必须先 select(kind) 再查 DOM —— select 会重建整个 pane 的 innerHTML，
   * 先拿到的元素引用随即失效。
   */
  focusLookup(kind, id) {
    this.toggle(true);
    this.select(kind);
    const el = this.sh.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('hit');
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => el.classList.remove('hit'), 1200);
  }

  renderStatus() {
    const s = this.h.getStats(), n = this.h.getItems().length;
    const ok = s.position + s.quote + s.fuzzy;
    const online = this.h.isOnline();
    const box = this.h.outbox();
    this.$('stat').innerHTML =
      `<span class="muted">${ok}/${n} · pos ${s.position} · quote ${s.quote} · fuzzy ${s.fuzzy}`
      + (s.orphan ? ` · <span class="bad">失锚 ${s.orphan}</span>` : '')
      + ` · <span class="${online ? 'ok' : 'bad'}">${online ? '已连服务' : '离线'}</span>`
      + (box ? ` · <span class="bad" title="此站点 origin 未加入白名单？见 ~/.contextflow/config.json">积压 ${box}</span>` : '')
      + '</span>';
    this.$('gn').textContent = n ? String(n) : '';
    this.$('b-comments').textContent = String(n);
    // 总结没有"条数"，只标有无内容
    this.$('b-note').textContent = (this.h.getNote() || '').trim() ? '·' : '';
    const ex = this.h.getLookups('explain');
    const running = ex.filter((e) => !e.value && e.extra?.status !== 'error').length;
    // 浮层关掉后，角标是"还有几个在跑"的唯一入口
    this.$('b-explain').textContent = running ? `${ex.length}·${running}⋯` : String(ex.length);
    this.$('b-translate').textContent = String(this.h.getLookups('translate').length);
  }

  /**
   * 「解释 / 翻译」tab：查询记录列表。
   * 排序与批注一致，按文档位置（见 getLookups）—— 既然点条目能跳原文、
   * 点原文能跳条目，两侧顺序就必须对得上，否则双向定位反而让人迷失。
   */
  renderLookups(kind) {
    const items = byPosition(this.h.getLookups(kind), this.h.positionOf);
    const pane = this.$(`p-${kind}`);
    if (!items.length) {
      pane.innerHTML = `<div class="empty">还没有${kind === 'explain' ? '解释' : '翻译'}记录。<br>`
        + `划选一段后点工具条上的「${kind === 'explain' ? '解释' : '翻译'}」。</div>`;
      return;
    }
    pane.innerHTML = items.map((it) => {
      const q = kind === 'explain' ? (it.extra?.question || '').trim() : '';
      const orphan = this.h.isOrphan(it.id);
      const st = it.extra?.status;
      const pending = !it.value;
      // 提交即落记录，所以列表里会有还没答案的条目。状态行让人看出它在跑到哪，
      // 失败了也留着并给「重试」—— 悄悄消失比留个失败条目更糟。
      const status = !pending ? ''
        : st === 'error'
          ? `<div class="st err"><span>✕ ${esc(it.extra?.error || '失败')}</span>`
            + '<button data-act="retry">重试</button></div>'
          : `<div class="st run"><span class="dot2"></span>`
            + `<span>${esc(it.extra?.progress || '进行中…')}</span></div>`;
      return `<div class="item k-${kind}${pending ? ' pend' : ''}" data-id="${it.id}">
        <span class="src lk${orphan ? ' off' : ''}" title="${orphan
          ? '原文已找不到，可能页面改版或内容尚未加载' : '点击跳到原文'}"
          >${esc((it.text || '').slice(0, 200))}</span>
        ${q ? `<div class="q2">❓ ${esc(q)}</div>` : ''}
        ${status}
        ${pending ? '' : `<div class="ans">${esc(it.value)}</div>`}
        <div class="tools">
          <span class="muted">${new Date(it.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
          <button data-act="del">删除</button>
        </div>
      </div>`;
    }).join('');
    for (const el of pane.querySelectorAll('.item')) {
      const id = el.dataset.id;
      // 失锚的不挂 onclick：点了也跳不动，留个可点样式只会让人反复试
      if (!this.h.isOrphan(id)) el.querySelector('.src').onclick = () => this.h.onLocate(id);
      el.querySelector('[data-act=del]').onclick = () => this.h.onDeleteLookup(id);
      const retry = el.querySelector('[data-act=retry]');
      if (retry) retry.onclick = () => this.h.onRetryLookup(id);
    }
  }

  render() {
    this.renderStatus();
    if (!this.open) return;
    if (this.tab === 'explain' || this.tab === 'translate') return this.renderLookups(this.tab);
    if (this.tab !== 'comments') return;

    // 正在输入时不重建列表，否则会丢焦点与光标位置
    const active = this.sh.activeElement;
    if (active && active.classList?.contains('cmt')) return;

    const items = byPosition(this.h.getItems(), this.h.positionOf);
    const pane = this.$('p-comments');

    if (!items.length) {
      pane.innerHTML = `<div class="empty">还没有批注。<br>在正文里划选一段试试。</div>`;
      return;
    }

    pane.innerHTML = items.map((it) => {
      const orphan = this.h.isOrphan(it.id);
      return `<div class="item" data-id="${it.id}">
        <span class="src" title="${orphan ? '原文已改动，无法定位' : '点击跳到原文'}">
          <span class="dot" style="background:${this.h.colorOf(it.id)}"></span>${esc(it.text || '')}
          ${orphan ? '<span class="bad"> （失锚）</span>' : ''}
        </span>
        <textarea class="cmt" rows="1" placeholder="写下你的想法…">${esc(this.h.commentOf(it.id) ?? '')}</textarea>
        <div class="tools"><button data-act="del">删除</button></div>
      </div>`;
    }).join('');

    for (const el of pane.querySelectorAll('.item')) {
      const id = el.dataset.id;
      const ta = el.querySelector('.cmt');
      grow(ta);
      let t = null;
      ta.addEventListener('input', () => {
        grow(ta);
        clearTimeout(t);
        t = setTimeout(() => { this.h.onCommentChange(id, ta.value); this.renderStatus(); }, 500);
      });
      ta.addEventListener('blur', () => { clearTimeout(t); this.h.onCommentChange(id, ta.value); });
      el.querySelector('.src').onclick = () => this.h.onLocate(id);
      el.querySelector('[data-act=del]').onclick = () => this.h.onDelete(id);
    }
  }
}

const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
