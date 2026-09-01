// 右侧停靠面板：翻译 / 解释 / 批注 / 总结 四个 tab（顺序见 TABS）。
//
// 注：浏览器自带的侧栏属于 browser chrome，页面 JS 无法注入。
// 这里做的是页面内右侧停靠层，视觉上紧贴其左侧。
//
// 两种布局模式（可切换、记忆）：
//   push  —— 给 <html> 加 margin-right，把正文挤到左边，与面板完全不重叠。默认。
//   float —— 浮在正文之上。用于 push 会破坏布局的站点（见 setMode 注释）。
// 宽度可拖左缘调整，写入 localStorage。
//
// 四个 tab 的条目一律按「文档中的位置」排序，而不是创建时间 —— 读者的心理模型是
// 「从上往下读」，按时间排会让同一段的记录散落在列表各处，回看时对不上原文。

import { T, shadowHost } from './theme.js';
import { guarded, describeError } from './guard.js';
import { MARKS } from '../core/highlight.js';
import { byPosition } from '../core/order.js';
import { Settings, SETTINGS_CSS } from './settings.js';
import { brandMark, icon } from './icons.js';

// tab 的顺序、内部键、显示名集中在这里 —— 此前散落在 HTML、select()、
// toggleSettings() 和四个 onclick 里，改一次顺序要同步改四处。
//
// key 是**内部键，不能改**：'note' 同时是事件的 action 名和 id 前缀
// （note:<urlKey>），server/mdfile.mjs、siyuan.mjs 都按它匹配。
// 显示名改成「总结」只动 label。
const TABS = [
  { key: 'translate', label: '翻译', icon: 'translate' },
  { key: 'explain', label: '解释', icon: 'explain' },
  { key: 'comments', label: '批注', icon: 'comment' },
  { key: 'note', label: '总结', icon: 'note' },
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
const appendTransition = (current, extra) => [
  ...String(current || '').split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('margin-right')),
  extra,
].join(', ');

const PANEL_CSS = `
  .wrap{position:fixed;top:0;right:0;height:100vh;container-type:inline-size;
        background-color:${T.paper};
        background-image:radial-gradient(circle at 1px 1px,var(--cf-grain) .65px,transparent .75px);
        background-size:5px 5px;border-left:1px solid ${T.line};
        font:13.5px/1.62 ${T.sans};color:${T.ink};display:flex;flex-direction:column;overflow:hidden;
        transform:translateX(100%);visibility:hidden;pointer-events:none;
        transition:transform .26s cubic-bezier(.22,.8,.3,1),visibility 0s linear .26s;
        will-change:transform;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .wrap::before{content:'';position:absolute;z-index:3;top:0;left:20px;width:46px;height:2px;background:${T.accent}}
  .wrap.open{transform:translateX(0);visibility:visible;pointer-events:auto;transition-delay:0s}
  .wrap.float{box-shadow:${T.shadowPanel}}

  /* 左缘像书页装订线；只有抓取时才变成强调色。 */
  .grab{position:absolute;left:0;top:0;bottom:0;width:8px;cursor:col-resize;
        z-index:4;background:transparent}
  .grab::after{content:'';position:absolute;left:2px;top:0;bottom:0;width:2px;
        background:transparent;transition:background .16s ease}
  .grab:hover::after,.grab.on::after{background:${T.accent}}

  header{padding:18px 16px 0;flex:0 0 auto;background:${T.paper}}
  .title{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .brand{display:flex;align-items:center;gap:9px;min-width:0;color:${T.ink}}
  .brand-seal{width:32px;height:32px;display:grid;place-items:center;flex:0 0 auto;
        border:1px solid ${T.lineStrong};border-radius:4px;background:${T.paperRaised}}
  .brand-seal .mk{width:19px;height:19px}
  .brand-copy{display:flex;min-width:0;flex-direction:column;gap:1px}
  .brand-name{font-size:14.5px;line-height:1.2;font-weight:680;letter-spacing:-.015em;white-space:nowrap}
  .brand-name em{font-style:normal;color:${T.accent}}
  .brand-sub{font-size:12px;line-height:1.25;font-weight:650;letter-spacing:.095em;color:${T.quote};white-space:nowrap}
  .title .r{gap:2px;flex:0 0 auto}
  .title .icon-action{width:30px;height:30px;padding:0;display:grid;place-items:center;color:${T.quote}}
  .title .icon-action .ico{width:15px;height:15px}
  .title .icon-action > span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}

  .tabs{display:flex;align-items:stretch;gap:0;margin:17px -16px 0;padding:0 9px;
        border-bottom:1px solid ${T.line};overflow-x:auto;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{flex:1 1 0;min-width:52px;display:flex;align-items:center;justify-content:center;gap:5px;
       height:42px;padding:0 5px;border-radius:0;color:${T.quote};font-size:12.5px;
       position:relative;background:none;white-space:nowrap}
  .tab::after{content:'';position:absolute;left:9px;right:9px;bottom:-1px;height:2px;
       background:transparent;transition:background .16s ease}
  .tab .ico{width:15px;height:15px}
  .tab:hover{color:${T.ink};background:transparent}
  .tab[aria-selected=true]{color:${T.ink};font-weight:670}
  .tab[aria-selected=true] .ico{color:${T.accent}}
  .tab[aria-selected=true]::after{background:${T.accent}}
  .badge{display:inline-grid;place-items:center;min-width:0;height:17px;margin-left:1px;
         color:${T.quote};font-size:12px;line-height:17px;text-align:center;font-weight:650;position:relative}
  .badge:empty{display:none}
  .badge.has-content{display:inline-grid;width:6px;min-width:6px;height:6px;border-radius:50%;background:${T.accent}}
  .badge.busy{padding-right:9px}
  .badge.busy::after{content:'';position:absolute;right:0;width:5px;height:5px;border-radius:50%;
        background:${T.accent};animation:cfpulse 1.1s ease-in-out infinite}

  .body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:0 18px 28px;scrollbar-gutter:stable}
  .pane{display:none}.pane.on{display:block;animation:cfenter .18s ease-out}
  @keyframes cfenter{from{opacity:.5;transform:translateY(2px)}to{opacity:1;transform:none}}

  /* 条目是阅读边栏，不是卡片：编号、细标尺、引文和自己的话构成层级。 */
  .item{--rail:${T.lineStrong};position:relative;padding:20px 0 18px 16px;border-bottom:1px solid ${T.lineSoft}}
  .item::before{content:'';position:absolute;left:0;top:23px;bottom:20px;width:2px;background:var(--rail)}
  .item:last-child{border-bottom:none}
  .item.comment{--rail:var(--mark,${T.accent})}
  .item.k-explain{--rail:${T.accent}}
  .item.k-translate{--rail:${T.blue}}
  .item-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;
        color:${T.quote};font-size:12px;font-weight:680;letter-spacing:.065em}
  .item-head .kind{color:${T.inkSoft}}
  .item-head .seq{font-variant-numeric:tabular-nums;letter-spacing:.04em}
  .item-head .orphan{color:${T.bad};letter-spacing:0;font-weight:600}
  .src{font:italic 14px/1.72 ${T.serif};color:${T.quote};cursor:pointer;
       display:block;transition:color .14s ease;overflow-wrap:anywhere}
  .src::before{content:'“';color:${T.lineStrong};font-size:20px;line-height:0;margin-right:3px;vertical-align:-2px}
  .src:hover{color:${T.inkSoft}}
  .cmt{width:100%;margin-top:11px;border:none;border-bottom:1px solid transparent;outline:none;resize:none;
       background:transparent;font:13.5px/1.68 ${T.sans};color:${T.ink};
       padding:1px 0 4px;overflow:hidden;min-height:1.68em;display:block;overflow-wrap:anywhere;
       transition:border-color .14s ease}
  .cmt::placeholder{color:${T.placeholder}}
  .cmt:focus{border-bottom-color:${T.accent}}
  .tools{display:flex;justify-content:flex-end;align-items:center;gap:2px;margin-top:7px;
         opacity:.58;transition:opacity .14s ease}
  .item:hover .tools,.item:focus-within .tools{opacity:1}
  .tools button{font-size:12px;padding:3px 7px}
  .tools .ico{width:14px;height:14px}

  .empty{min-height:min(52vh,430px);display:grid;place-content:center;justify-items:center;
        color:${T.quote};padding:36px 10px;text-align:center;line-height:1.72}
  .empty .empty-icon{width:42px;height:42px;display:grid;place-items:center;margin-bottom:15px;
        border:1px solid ${T.line};border-radius:50%;color:${T.accent};background:${T.paperRaised}}
  .empty .empty-icon .ico{width:19px;height:19px}
  .empty strong{font:600 15px/1.45 ${T.serif};color:${T.inkSoft}}
  .empty span{max-width:230px;margin-top:5px;font-size:12.5px}

  /* 查询标记沿用正文里的线型，原文与记录能一眼配对。 */
  .src.lk{text-decoration-line:underline;text-decoration-thickness:1px;text-underline-offset:5px}
${Object.entries(MARKS).map(([k, m]) => `  .item.k-${k} .src.lk{text-decoration-style:${m.line};text-decoration-color:${m.color}}
  :host([data-theme=dark]) .item.k-${k} .src.lk{text-decoration-color:${m.darkColor || m.color}}`).join("\n")}
  .src.off{cursor:default;opacity:.72;text-decoration-style:solid!important;text-decoration-color:${T.lineSoft}!important}
  .src.off:hover{color:${T.quote}}
  .item.hit{background:${T.accentWash};box-shadow:12px 0 0 ${T.accentWash},-8px 0 0 ${T.accentWash}}
  .q2{display:flex;align-items:flex-start;gap:7px;margin-top:10px;font-size:13px;font-weight:650;color:${T.accent}}
  .q2 .ico{width:15px;height:15px;margin-top:2px}
  .st{margin-top:9px;font-size:12.5px;display:flex;align-items:center;gap:7px}
  .st.run{color:${T.quote}}.st.err{color:${T.bad}}
  .st .ico{width:15px;height:15px}.st .dot2{width:6px;height:6px;border-radius:50%;background:${T.accent};flex:0 0 auto;animation:cfpulse 1.1s ease-in-out infinite}
  @keyframes cfpulse{0%,100%{opacity:.28;transform:scale(.82)}50%{opacity:1;transform:scale(1)}}
  .st button{border:1px solid ${T.line};background:transparent;padding:3px 8px;font-size:12px}
  .st button:hover{background:${T.hover}}
  .item.pend .src.lk{text-decoration-style:dotted;text-decoration-color:${T.line}}
  .ans{margin-top:10px;font:13.5px/1.7 ${T.sans};color:${T.ink};white-space:pre-wrap;overflow-wrap:anywhere}
  .tools .muted{margin-right:auto;font-variant-numeric:tabular-nums}

  /* 速览像编辑批注，不另铺一张卡片。 */
  .brief{position:relative;margin:20px 0 24px;padding:16px 0 18px 16px;border-top:1px solid ${T.line};border-bottom:1px solid ${T.line};
         font:13.5px/1.72 ${T.sans};color:${T.ink};white-space:pre-wrap;overflow-wrap:anywhere}
  .brief::before{content:'';position:absolute;left:0;top:18px;bottom:18px;width:2px;background:${T.accent}}
  .brief:empty{display:none}
  .brief .hd2{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;
              font-size:12px;font-weight:700;letter-spacing:.065em;color:${T.inkSoft}}
  .brief .brief-label{display:inline-flex;align-items:center;gap:6px}
  .brief .brief-label .ico{width:14px;height:14px;color:${T.accent}}
  .brief .hd2 button{font-size:12px;padding:3px 6px;letter-spacing:0}
  .brief .txt{white-space:pre-wrap}
  .brief .ft{margin-top:9px;font-size:12px;color:${T.quote};font-variant-numeric:tabular-nums}
  .brief.run .txt{color:${T.quote};display:flex;align-items:baseline;gap:7px}
  .brief.run .dot2{width:6px;height:6px;border-radius:50%;background:${T.accent};flex:0 0 auto;position:relative;top:-1px;animation:cfpulse 1.1s ease-in-out infinite}
  .brief.err::before{background:${T.bad}}.brief.err .txt{color:${T.bad}}

  .note-head{display:flex;align-items:center;justify-content:space-between;margin:20px 0 10px;
        color:${T.quote};font-size:12px;font-weight:680;letter-spacing:.065em}
  .note-head strong{color:${T.inkSoft};font:inherit}.note-head span:last-child{font-weight:500;letter-spacing:0}
  .note{width:100%;height:calc(100vh - 285px);min-height:240px;border:none;border-left:2px solid ${T.line};
        background-color:transparent;
        background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 29px,${T.lineSoft} 29px,${T.lineSoft} 30px);
        padding:3px 12px 12px;font:13.5px/30px ${T.sans};color:${T.ink};resize:none;outline:none}
  .note::placeholder{color:${T.placeholder}}
  .note:focus{border-left-color:${T.accent};box-shadow:none}

  footer{flex:0 0 auto;padding:10px 16px 12px;border-top:1px solid ${T.line};background:${T.paper};font-variant-numeric:tabular-nums}
  .wrap.settings-mode > footer{display:none}
  footer .r{justify-content:space-between;gap:8px}
  #sync{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12.5px;color:${T.inkSoft}}
  #sync .ico{width:14px;height:14px;color:${T.accent}}
  .anchor-stat{position:relative;min-width:0;padding:4px 5px;margin-left:-5px;font-size:12px}
  .stat-main{display:flex;align-items:center;gap:6px;min-width:0;color:${T.quote};white-space:nowrap}
  .stat-main .led{width:6px;height:6px;border-radius:50%;background:${T.bad};flex:0 0 auto}.stat-main .led.online{background:${T.ok}}
  .stat-main .warn{color:${T.bad}}
  .stat-tip{position:absolute;left:0;bottom:calc(100% + 10px);z-index:4;width:max-content;max-width:290px;
        padding:10px 11px;border:1px solid ${T.line};border-radius:7px;background:${T.paperRaised};
        color:${T.inkSoft};box-shadow:${T.shadowControl};font:12.5px/1.58 ${T.sans};text-align:left;
        white-space:normal;opacity:0;visibility:hidden;transform:translateY(3px);pointer-events:none;
        transition:opacity .14s ease,transform .14s ease,visibility .14s ease}
  .stat-tip::after{content:'';position:absolute;left:14px;top:100%;width:7px;height:7px;background:${T.paperRaised};border-right:1px solid ${T.line};border-bottom:1px solid ${T.line};transform:translateY(-4px) rotate(45deg)}
  .anchor-stat:hover .stat-tip,.anchor-stat:focus-visible .stat-tip{opacity:1;visibility:visible;transform:translateY(0)}
  .syncmsg{display:none;margin-top:7px;font-size:12px;line-height:1.55;overflow-wrap:anywhere}
  .syncmsg.on{display:block}.syncmsg.bad{color:${T.bad}}.syncmsg.ok{color:${T.quote}}
  .syncmsg .hint{color:${T.quote};display:block;margin-top:2px}

  /* 展开与收起共用同一个固定按钮。手势过程中不替换命中目标，避免 pointerdown
     收起后新出现的展开按钮接到同一次手势，造成面板闪一下又展开。 */
  .panel-toggle{position:fixed;z-index:5;top:calc(46% - 25px);right:0;width:31px;height:50px;padding:0;display:grid;place-items:center;
        color:${T.inkSoft};border:1px solid ${T.line};border-right:none;border-radius:6px 0 0 6px;
        background:${T.paper};box-shadow:${T.shadowControl};transition:right .26s cubic-bezier(.22,.8,.3,1)}
  .panel-toggle::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:2px;background:${T.accent}}
  .panel-toggle .ico{width:15px;height:15px}.panel-toggle:hover{color:${T.accent};background:${T.paperRaised}}
  .panel-toggle:active{transform:none}.panel-toggle:focus-visible{outline:2px solid ${T.focusLine};outline-offset:2px}
  .panel-toggle .toggle-close{display:none}.panel-toggle.open .toggle-open{display:none}.panel-toggle.open .toggle-close{display:block}
  .panel-toggle #gn{position:absolute;right:2px;top:2px;display:grid;place-items:center;min-width:15px;height:15px;padding:0 3px;
        border:1px solid ${T.line};border-radius:8px;background:${T.paperRaised};color:${T.quote};font:600 10px/1 ${T.sans}}
  .panel-toggle #gn:empty,.panel-toggle.open #gn{display:none}

  .foot-actions{display:flex;align-items:center;gap:2px;margin-left:auto}
  .foot-actions button{position:relative;display:inline-flex;align-items:center;gap:5px;padding:5px 6px;white-space:nowrap;color:${T.quote};font-size:12px}
  .foot-actions button:hover{color:${T.ink};background:${T.hover}}.foot-actions .ico{width:14px;height:14px}.foot-actions #sync .ico{color:${T.accent}}
  .has-tip .tip{position:absolute;right:0;bottom:calc(100% + 9px);z-index:8;width:230px;padding:9px 10px;border:1px solid ${T.line};border-radius:7px;
        background:${T.paperRaised};color:${T.inkSoft};box-shadow:${T.shadowControl};font:12px/1.55 ${T.sans};text-align:left;white-space:normal;
        opacity:0;visibility:hidden;pointer-events:none;transform:translateY(3px);transition:opacity .14s ease,transform .14s ease,visibility .14s ease}
  .has-tip .tip::after{content:'';position:absolute;right:13px;top:100%;width:7px;height:7px;background:${T.paperRaised};border-right:1px solid ${T.line};border-bottom:1px solid ${T.line};transform:translateY(-4px) rotate(45deg)}
  .has-tip:hover .tip,.has-tip:focus-visible .tip{opacity:1;visibility:visible;transform:none}

  @container (max-width:320px){
    header{padding-left:13px;padding-right:13px}.tabs{margin-left:-13px;margin-right:-13px}
    .brand-sub{display:none}.brand-seal{width:29px;height:29px}.brand-seal .mk{width:17px;height:17px}
    .title .icon-action{width:28px;height:28px}.body{padding-left:14px;padding-right:14px}
    footer{padding-left:13px;padding-right:13px}.tab{gap:4px;padding-left:3px;padding-right:3px;font-size:12px}
    .foot-actions .label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.foot-actions button{width:28px;height:28px;justify-content:center;padding:0}
  }
  @media (hover:none){.tools{opacity:1}}
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
    this.rootTransitionBefore = null;

    const sh = shadowHost('panel', PANEL_CSS);
    sh.innerHTML += `
      <button class="panel-toggle" id="panelToggle" type="button" title="展开 ContextFlow" aria-label="展开 ContextFlow" aria-controls="wrap" aria-expanded="false">
        <span class="toggle-open" aria-hidden="true">${icon('chevron-left')}</span>
        <span class="toggle-close" aria-hidden="true">${icon('chevron-right')}</span><span id="gn"></span>
      </button>
      <div class="wrap" id="wrap">
        <div class="grab" id="grab" title="拖动调整宽度"></div>
        <header>
          <div class="title">
            <span class="brand">
              <span class="brand-seal">${brandMark()}</span>
              <span class="brand-copy"><span class="brand-name">Context<em>Flow</em></span><span class="brand-sub" id="brandSub">READING MARGIN</span></span>
            </span>
            <span class="r">
              <button class="icon-action" id="cfg" title="配置翻译、解释与笔记同步" aria-label="配置">${icon('settings')}<span>配置</span></button>
              <button class="icon-action" id="mode" title="切换面板布局" aria-label="切换面板布局"></button>
            </span>
          </div>
          <div class="tabs" role="tablist">
            ${TABS.map((t) => `<button class="tab" id="t-${t.key}" role="tab">${icon(t.icon)}`
              + `<span>${t.label}</span><span class="badge" id="b-${t.key}"></span></button>`).join('')}
          </div>
        </header>
        <div class="body">
          ${TABS.map((t) => `<div class="pane" id="p-${t.key}">${t.key === 'note'
            // 速览（机器生成）摆在你自己写的总结**上面**：打开面板先看它，
            // 想补充再往下写。两者刻意分开，免得分不清谁的想法。
            ? '<div class="brief" id="brief"></div>'
              + '<div class="note-head"><strong>你的笔记</strong><span>自动保存</span></div>'
              + '<textarea class="note" id="note"'
              + ' placeholder="记下整体理解、与其他工作的关系，以及仍待验证的问题…"></textarea>'
            : ''}</div>`).join('')}
          <div class="set" id="p-set"></div>
        </div>
        <footer>
          <div class="r">
            <button class="anchor-stat" id="stat" type="button" aria-describedby="stat-tip"></button>
            <span class="foot-actions">
              <button id="copyMd" class="has-tip" type="button" aria-label="复制 Markdown" aria-describedby="copy-tip">${icon('copy')}<span class="label">复制</span><span class="tip" id="copy-tip" role="tooltip">复制当前文章的速览、翻译、解释、批注和总结；无需本地服务。</span></button>
              <button id="downloadMd" class="has-tip" type="button" aria-label="下载 Markdown" aria-describedby="download-tip">${icon('download')}<span class="label">下载</span><span class="tip" id="download-tip" role="tooltip">把当前文章的全部本地记录下载为 Markdown；离线也可用。</span></button>
              <button id="sync" class="has-tip" type="button" aria-label="同步到笔记" aria-describedby="sync-tip">${icon('sync')}<span class="label" id="syncLabel">同步</span><span class="tip" id="sync-tip" role="tooltip">同步到当前配置的 Obsidian 或 Markdown 文件夹。</span></button>
            </span>
          </div>
          <div class="syncmsg" id="syncmsg"></div>
        </footer>
      </div>`;
    this.sh = sh;
    this.$ = (id) => sh.getElementById(id);

    // 指针按下就切换，避免按钮横向移动后浏览器取消 click；真实指针产生的后续
    // click 一律忽略，键盘 Enter / Space 的 click(detail=0)仍正常工作。
    const panelToggle = this.$('panelToggle');
    panelToggle.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      panelToggle.setPointerCapture?.(e.pointerId);
      this.toggle(!this.open);
    });
    panelToggle.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      if (panelToggle.hasPointerCapture?.(e.pointerId)) panelToggle.releasePointerCapture(e.pointerId);
    });
    panelToggle.addEventListener('pointercancel', (e) => {
      e.stopPropagation();
      if (panelToggle.hasPointerCapture?.(e.pointerId)) panelToggle.releasePointerCapture(e.pointerId);
    });
    panelToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail === 0) this.toggle(!this.open);
    });
    // 0/0 仍可点击重新解析；工程细节只放 title，普通用户不再直接看到术语。
    this.$('stat').style.cursor = 'pointer';
    this.$('stat').onclick = () => this.h.onReanchor();
    this.$('sync').onclick = () => this.doSync();
    this.$('copyMd').onclick = this.guard(async () => this.syncMsg(await this.h.onCopyMarkdown(), 'ok'));
    this.$('downloadMd').onclick = this.guard(() => this.syncMsg(this.h.onDownloadMarkdown(), 'ok'));
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
    if (this.ui.open) this.toggle(true, false);
  }

  /** 配置界面与四个 tab 互斥显示 */
  toggleSettings() {
    const on = !this.settingsOpen;
    this.settingsOpen = on;
    this.toggle(true);
    const folio = on && Settings.folio === true;
    this.$('wrap').classList.toggle('settings-mode', folio);
    this.$('brandSub').textContent = folio ? 'SETTINGS' : 'READING MARGIN';
    this.$('p-set').classList.toggle('on', on);
    const cfg = this.$('cfg');
    setButtonContent(cfg, on ? 'arrow-left' : 'settings', on ? '返回' : '配置');
    cfg.setAttribute('aria-label', on ? '返回阅读记录' : '配置');
    cfg.title = on ? '返回阅读记录' : '配置翻译、解释与笔记同步';
    for (const k of TAB_KEYS) this.$(`p-${k}`).classList.toggle('on', !on && this.tab === k);
    this.sh.querySelector('.tabs').style.display = on ? 'none' : 'flex';
    if (on) {
      // onBlock 交给 main.js 的 blockHere 做就地停用（撤 UI、落名单、弹恢复卡）
      if (!this.settings) this.settings = new Settings(this.sh, this.$('p-set'), this.h.api, this.h.onBlock);
      this.settings.load();
    }
  }

  async doSync() {
    const label = this.$('syncLabel');
    const old = label.textContent;
    label.textContent = '同步中…';
    this.syncMsg('');
    try {
      const r = await this.h.onSync();
      // 新增与改写要分开报：只报总数的话，"改了总结再同步"看起来像什么都没发生
      const bits = [r.inserted ? `新增 ${r.inserted}` : null,
        r.updated ? `改写 ${r.updated}` : null].filter(Boolean);
      label.textContent = bits.length ? '已同步' : '已是最新';
      const where = (r.files || r.docs || []).join('、');
      if (bits.length && where) this.syncMsg(`${r.articles} 篇 → ${where}`, 'ok');
    } catch (e) {
      label.textContent = '同步失败';
      // 原因必须出现在界面上。只 console.error 的话，用户看到的是一个
      // 没有下文的"同步失败"，连"服务没重启"这种一句话就能解决的问题都看不出来。
      this.syncMsg(e.message, 'bad', hintFor(e.message));
      console.error('[ContextFlow] 同步到笔记失败：', e.message);
    }
    setTimeout(() => { label.textContent = old; }, 2600);
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
    // 同一按钮始终存在：收起时贴视口右缘，展开时贴面板左缘。
    // 它是 wrap 的兄弟，既不会被 overflow 裁切，也不会在手势中换成另一个元素。
    this.$('panelToggle').style.right = this.open ? `${w}px` : '0px';

    const root = document.documentElement;
    if (this.open && this.ui.mode === 'push') {
      if (this.rootMarginBefore === null) {
        this.rootMarginBefore = root.style.marginRight;
        this.rootTransitionBefore = root.style.transition;
      }
      root.style.transition = appendTransition(this.rootTransitionBefore, 'margin-right .26s cubic-bezier(.22,.8,.3,1)');
      root.style.marginRight = `${w}px`;
    } else if (this.rootMarginBefore !== null) {
      root.style.transition = appendTransition(this.rootTransitionBefore, 'margin-right .26s cubic-bezier(.22,.8,.3,1)');
      root.style.marginRight = this.rootMarginBefore;
      const restore = this.rootTransitionBefore;
      clearTimeout(this._marginTimer);
      this._marginTimer = setTimeout(() => { root.style.transition = restore || ''; }, 280);
      this.rootMarginBefore = null;
      this.rootTransitionBefore = null;
    }
    const modeLabel = this.ui.mode === 'push' ? '挤开正文' : '浮在正文上';
    setButtonContent(this.$('mode'), this.ui.mode === 'push' ? 'dock' : 'float', modeLabel);
    const modeHint = this.ui.mode === 'push'
      ? '当前挤开正文，点击切换为浮层' : '当前浮在正文上，点击切换为挤开正文';
    this.$('mode').setAttribute('aria-label', modeHint);
    this.$('mode').title = modeHint;
  }

  setMode(mode) {
    this.ui.mode = mode;
    // 先还原旧模式留下的外边距，再按新模式重算
    if (this.rootMarginBefore !== null) {
      document.documentElement.style.marginRight = this.rootMarginBefore;
      document.documentElement.style.transition = this.rootTransitionBefore || '';
      this.rootMarginBefore = null;
      this.rootTransitionBefore = null;
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

  toggle(open = !this.open, notify = true) {
    const was = this.open;
    this.open = open;
    this.ui.open = open;
    this.$('wrap').classList.toggle('open', open);
    const panelToggle = this.$('panelToggle');
    panelToggle.classList.toggle('open', open);
    panelToggle.setAttribute('aria-expanded', String(open));
    panelToggle.setAttribute('aria-label', open ? '收起 ContextFlow' : '展开 ContextFlow');
    panelToggle.title = open ? '收起 ContextFlow' : '展开 ContextFlow';
    this.applyLayout();
    saveUI(this.ui);
    if (open) this.render();
    // 从收起变为展开时才通知 —— 这是"打开插件"的时刻
    if (notify && open && !was) this.h.onOpen?.();
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

  /**
   * 把 handler 里的异常摊到界面上（实现见 guard.js）。
   * 之前这里写了 this.guard(...) 却没有实现 —— 那次它发生在速览的成功路径上，
   * 把一次跑成的速览显示成了 "速览失败：this.guard is not a function"。
   */
  guard(fn) { return guarded(fn, (e) => this.onHandlerError(e)); }

  onHandlerError(e) {
    this.syncMsg(describeError(e), 'bad');
    console.error('[ContextFlow] 面板出错：', e);
  }

  /**
   * 速览区。
   * @param {{state:'run'|'ok'|'err', text:string, meta?:string, retry?:boolean}} o
   */
  renderBrief(o) {
    const el = this.$('brief');
    if (!el) return;
    if (!o) { el.className = 'brief'; el.innerHTML = ''; return; }
    el.className = `brief ${o.state === 'ok' ? '' : o.state}`;
    // 运行态给一个脉动点：否则进度文字（"…不支持会话续接，每次发完整对话…"）
    // 读起来像最终结果，看不出还在跑
    const dot = o.state === 'run' ? '<span class="dot2"></span>' : '';
    el.innerHTML = `<div class="hd2"><span class="brief-label">${icon('sparkle')}<span>AI 速览</span></span>`
      + `${o.retry ? `<button class="with-icon" data-act="rebrief">${icon('retry')}<span>重新生成</span></button>` : ''}</div>`
      + `<div class="txt">${dot}${esc(o.text || '')}</div>`
      + `${o.meta ? `<div class="ft">${esc(o.meta)}</div>` : ''}`;
    const b = el.querySelector('[data-act=rebrief]');
    if (b) b.onclick = this.guard(() => this.h.onSummarize?.(true));
  }

  renderStatus() {
    const s = this.h.getStats(), n = this.h.getItems().length;
    const ok = s.position + s.quote + s.fuzzy;
    const online = this.h.isOnline();
    const box = this.h.outbox();
    const main = n ? `已定位 ${ok}/${n}` : '暂无批注';
    const details = n
      ? `精确 ${s.position} · 文本匹配 ${s.quote} · 模糊恢复 ${s.fuzzy}`
        + (s.orphan ? ` · 未定位 ${s.orphan}` : '')
      : '点击重新解析正文锚点';
    this.$('stat').innerHTML = `<span class="stat-main">`
      + `<span class="led${online ? ' online' : ''}"></span><span>${main}</span>`
      + `${s.orphan ? `<span class="warn">未定位 ${s.orphan}</span>` : ''}`
      + `${box ? `<span class="warn">待发送 ${box}</span>` : ''}</span>`
      + `<span class="stat-tip" id="stat-tip" role="tooltip">${details}<br>`
      + `${online ? 'AI 通道可用' : '当前离线'} · 点击重新解析</span>`;
    this.$('gn').textContent = n ? String(n) : '';
    this.$('b-comments').textContent = n ? String(n) : '';
    // 总结没有"条数"，用一个克制的琥珀点表示已有内容，不再混用字符"·"。
    const hasBrief = this.h.getLookups('summary').some((e) => e.value);
    const hasNote = !!((this.h.getNote() || '').trim() || hasBrief);
    this.$('b-note').textContent = '';
    this.$('b-note').classList.toggle('has-content', hasNote);
    const ex = this.h.getLookups('explain');
    const running = ex.filter((e) => !e.value && e.extra?.status !== 'error').length;
    // 浮层关掉后，角标仍要诚实地告诉用户有任务在跑；用脉动点而不是“⋯”字符。
    this.$('b-explain').textContent = ex.length ? String(ex.length) : '';
    this.$('b-explain').classList.toggle('busy', running > 0);
    this.$('b-explain').title = running ? `${running} 条正在生成` : '';
    const tr = this.h.getLookups('translate').length;
    this.$('b-translate').textContent = tr ? String(tr) : '';
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
      const label = kind === 'explain' ? '解释' : '翻译';
      pane.innerHTML = emptyView(kind, `还没有${label}记录`, `划选一段文字，再从工具条选择「${label}」。`);
      return;
    }
    pane.innerHTML = items.map((it, index) => {
      const q = kind === 'explain' ? (it.extra?.question || '').trim() : '';
      const orphan = this.h.isOrphan(it.id);
      const st = it.extra?.status;
      const pending = !it.value;
      // 提交即落记录，所以列表里会有还没答案的条目。状态行让人看出它在跑到哪，
      // 失败了也留着并给「重试」—— 悄悄消失比留个失败条目更糟。
      const status = !pending ? ''
        : st === 'deferred'
          ? `<div class="st err">${icon('error')}<span>当前离线，记录已保留</span>`
            + `<button class="with-icon" data-act="retry">${icon('retry')}<span>重试</span></button></div>`
          : st === 'error'
          ? `<div class="st err">${icon('error')}<span>${esc(it.extra?.error || '失败')}</span>`
            + `<button class="with-icon" data-act="retry">${icon('retry')}<span>重试</span></button></div>`
          : `<div class="st run"><span class="dot2"></span>`
            + `<span>${esc(it.extra?.progress || '进行中…')}</span></div>`;
      return `<div class="item k-${kind}${pending ? ' pend' : ''}" data-id="${it.id}">
        <div class="item-head"><span class="kind">${kind === 'explain' ? '解释' : '翻译'} / ${seq(index)}</span>`
        + `<span class="seq">${orphan ? '<span class="orphan">未定位</span>' : '原文位置'}</span></div>
        <span class="src lk${orphan ? ' off' : ''}" title="${orphan
          ? '原文已找不到，可能页面改版或内容尚未加载' : '点击跳到原文'}"
          >${esc((it.text || '').slice(0, 200))}</span>
        ${q ? `<div class="q2">${icon('help')}<span>${esc(q)}</span></div>` : ''}
        ${status}
        ${pending ? '' : `<div class="ans">${esc(it.value)}</div>`}
        <div class="tools">
          <span class="muted">${formatTime(it.createdAt)}</span>
          <button class="with-icon" data-act="del">${icon('trash')}<span>删除</span></button>
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
      pane.innerHTML = emptyView('comment', '还没有批注', '划选正文，把值得保留的想法写在阅读边栏里。');
      return;
    }

    pane.innerHTML = items.map((it, index) => {
      const orphan = this.h.isOrphan(it.id);
      return `<div class="item comment" data-id="${it.id}" style="--mark:${this.h.colorOf(it.id)}">
        <div class="item-head"><span class="kind">批注 / ${seq(index)}</span>`
        + `<span class="seq">${orphan ? '<span class="orphan">未定位</span>' : '原文位置'}</span></div>
        <span class="src${orphan ? ' off' : ''}" title="${orphan ? '原文已改动，无法定位' : '点击跳到原文'}">
          ${esc(it.text || '')}
        </span>
        <textarea class="cmt" rows="1" placeholder="写下你的想法…">${esc(this.h.commentOf(it.id) ?? '')}</textarea>
        <div class="tools"><button class="with-icon" data-act="del">${icon('trash')}<span>删除</span></button></div>
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
      if (!this.h.isOrphan(id)) el.querySelector('.src').onclick = () => this.h.onLocate(id);
      el.querySelector('[data-act=del]').onclick = () => this.h.onDelete(id);
    }
  }
}

const emptyView = (iconName, title, hint) => `<div class="empty">
  <span class="empty-icon">${icon(iconName)}</span><strong>${esc(title)}</strong><span>${esc(hint)}</span>
</div>`;
const seq = (index) => String(index + 1).padStart(2, '0');
const formatTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
};

const setButtonContent = (el, iconName, label) => {
  el.innerHTML = `${icon(iconName)}<span>${label}</span>`;
};

const grow = (ta) => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
