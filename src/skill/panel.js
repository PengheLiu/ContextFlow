// 阅读工作台：阅读记录 / 文章速览 / 我的笔记。
//
// 注：浏览器自带的侧栏属于 browser chrome，页面 JS 无法注入。
// 这里做的是页面内右侧停靠层，视觉上紧贴其左侧。
//
// 两种布局模式（可切换、记忆）：
//   push  —— 给 <html> 加 margin-right，把正文挤到左边，与面板完全不重叠。默认。
//   float —— 浮在正文之上。用于 push 会破坏布局的站点（见 setMode 注释）。
// 宽度可拖左缘调整，写入 localStorage。
//
// 阅读记录一律按「文档中的位置」排序，而不是创建时间 —— 读者的心理模型是
// 「从上往下读」，按时间排会让同一段的记录散落在列表各处，回看时对不上原文。

import { T, shadowHost } from './theme.js';
import { guarded, describeError } from './guard.js';
import { MARKS } from '../core/highlight.js';
import { Settings, SETTINGS_CSS } from './settings.js';
import { brandMark, icon } from './icons.js';
import { MARKDOWN_CSS, renderMarkdownInto } from './markdown-view.js';
import { RichComposer, RICH_COMPOSER_CSS } from './rich-composer.js';
import { RecordList, RECORD_CSS } from './record-list.js';

// tab 的顺序、内部键、显示名集中在这里 —— 此前散落在 HTML、select()、
// toggleSettings() 和四个 onclick 里，改一次顺序要同步改四处。
//
// UI navigation is independent of persisted event actions. No data migration.
const TABS = [
  { key: 'records', label: '阅读记录', icon: 'comment' },
  { key: 'brief', label: '文章速览', icon: 'sparkle' },
  { key: 'note', label: '我的笔记', icon: 'note' },
];
const TAB_KEYS = TABS.map((t) => t.key);

import { browserStorage } from '../core/browser-storage.js';

const UI_KEY = 'contextflow:ui';
const MIN_W = 260;
const MAX_FRAC = 0.6;          // 最宽不超过视口 60%

const loadUI = () => {
  try { return { width: 360, mode: 'push', open: false, ...JSON.parse(browserStorage().getItem(UI_KEY) || '{}') }; }
  catch { return { width: 360, mode: 'push', open: false }; }
};
const saveUI = (ui) => { try { browserStorage().setItem(UI_KEY, JSON.stringify(ui)); } catch { /* 配额 */ } };
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
  .item-head.loc{cursor:pointer}.item-head.loc:hover{color:${T.inkSoft}}
  .item-head .kind{color:${T.inkSoft}}
  .item-head .seq{font-variant-numeric:tabular-nums;letter-spacing:.04em}
  .item-head .orphan{color:${T.bad};letter-spacing:0;font-weight:600}
  .src{font:italic 14px/1.72 ${T.serif};color:${T.quote};cursor:pointer;
       display:block;transition:color .14s ease;overflow-wrap:anywhere}
  .src::before{content:'“';color:${T.lineStrong};font-size:20px;line-height:0;margin-right:3px;vertical-align:-2px}
  .src:hover{color:${T.inkSoft}}
  .cmt{margin-top:9px}.cmt .rc-figure{max-width:100%}.cmt .rc-media img{max-height:220px}
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
  .item.editing{background:${T.accentWash};box-shadow:12px 0 0 ${T.accentWash},-8px 0 0 ${T.accentWash}}
  .item.editing::before{background:${T.accent}}
  .item-head .edit-state{display:inline-flex;align-items:center;gap:4px;color:${T.accent};letter-spacing:0;font-weight:650}
  .item-head .edit-state .ico{width:13px;height:13px}
  .q2{display:flex;align-items:flex-start;gap:7px;margin-top:10px;font-size:13px;font-weight:650;color:${T.accent}}
  .q2 .ico{width:15px;height:15px;margin-top:2px}
  .st{margin-top:9px;font-size:12.5px;display:flex;align-items:center;gap:7px}
  .st.run{color:${T.quote}}.st.err{color:${T.bad}}
  .st .ico{width:15px;height:15px}.st .dot2{width:6px;height:6px;border-radius:50%;background:${T.accent};flex:0 0 auto;animation:cfpulse 1.1s ease-in-out infinite}
  @keyframes cfpulse{0%,100%{opacity:.28;transform:scale(.82)}50%{opacity:1;transform:scale(1)}}
  .st button{border:1px solid ${T.line};background:transparent;padding:3px 8px;font-size:12px}
  .st button:hover{background:${T.hover}}
  .item.pend .src.lk{text-decoration-style:dotted;text-decoration-color:${T.line}}
  .ans{margin-top:10px}
  .supplement{margin-top:13px;padding-top:10px;border-top:1px dashed ${T.line}}
  .supplement-label{margin-bottom:5px;color:${T.quote};font-size:11.5px;font-weight:680;letter-spacing:.06em}
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
  .brief .ft{margin-top:9px;font-size:12px;color:${T.quote};font-variant-numeric:tabular-nums}
  .brief.run .txt{color:${T.quote};display:flex;align-items:baseline;gap:7px}
  .brief.run .dot2{width:6px;height:6px;border-radius:50%;background:${T.accent};flex:0 0 auto;position:relative;top:-1px;animation:cfpulse 1.1s ease-in-out infinite}
  .brief.err::before{background:${T.bad}}.brief.err .txt{color:${T.bad}}
  .stream-preview{margin-top:12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.inkSoft};font:13.5px/1.72 ${T.sans}}

  .note-head{display:flex;align-items:center;justify-content:space-between;margin:20px 0 10px;
        color:${T.quote};font-size:12px;font-weight:680;letter-spacing:.065em}
  .note-head strong{color:${T.inkSoft};font:inherit}.note-head span:last-child{font-weight:500;letter-spacing:0}
  .note{width:100%;min-height:240px;border:none;border-left:2px solid ${T.line};
        background-color:transparent;
        background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 29px,${T.lineSoft} 29px,${T.lineSoft} 30px);
        padding:3px 12px 12px;font:13.5px/30px ${T.sans};color:${T.ink};outline:none}
  .note:focus-within{border-left-color:${T.accent};box-shadow:none}
  .note .rc-text{line-height:30px;background-image:none}.note .rc-media img{max-height:360px}

  footer{flex:0 0 auto;padding:10px 16px 12px;border-top:1px solid ${T.line};background:${T.paper};font-variant-numeric:tabular-nums}
  .storage-note{margin-top:7px;color:${T.quote};font-size:11px;line-height:1.45}
  .item-head.loc:focus-visible,.src[role=button]:focus-visible{outline:2px solid ${T.focusLine};outline-offset:3px;border-radius:3px}
  .wrap.settings-mode > footer{display:none}
  footer .r{justify-content:space-between;gap:8px}
  #sync{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12.5px;color:${T.inkSoft}}
  #sync .ico{width:14px;height:14px;color:${T.accent}}
  .anchor-stat{position:relative;min-width:0;padding:4px 5px;margin-left:-5px;font-size:12px}
  .stat-main{display:flex;align-items:center;gap:6px;min-width:0;color:${T.quote};white-space:nowrap}
  .stat-main .led{width:6px;height:6px;border-radius:50%;background:${T.quote};flex:0 0 auto}.stat-main .led.online{background:${T.ok}}
  .connection-note{flex:0 0 auto;margin:0 16px 12px;padding:10px 11px;border:1px solid ${T.line};border-radius:6px;font-size:12px;color:${T.quote};background:${T.paperRaised}}
  .connection-note[hidden]{display:none}.connection-note strong{display:block;color:${T.inkSoft};font-size:12px}.connection-note p{margin:3px 0 7px;line-height:1.55}.connection-note button{font-size:12px;color:${T.accent};padding:3px 0}
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
        background:${T.paper};box-shadow:${T.shadowControl};transition:left .26s cubic-bezier(.22,.8,.3,1)}
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
    .title .r{gap:0}.brand{gap:6px}.brand-seal{width:24px;height:24px}.brand-name{font-size:13px}
    .title .icon-action{width:28px;height:28px}.body{padding-left:14px;padding-right:14px}
    footer{padding-left:13px;padding-right:13px}.tab{gap:4px;padding-left:3px;padding-right:3px;font-size:12px}
    .foot-actions .label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.foot-actions button{width:28px;height:28px;justify-content:center;padding:0}
  }
  @media (hover:none){.tools{opacity:1}}
  .grab:focus-visible{outline:2px solid ${T.accent};outline-offset:-2px;background:${T.accentWash}}
  @media(prefers-reduced-motion:reduce){.wrap,.panel-toggle,.grab::after{transition:none!important;animation:none!important}}
  @media(forced-colors:active){.wrap,.panel-toggle{border:1px solid CanvasText}.grab:focus-visible{outline:2px solid Highlight}.grab::after{background:CanvasText}}
${SETTINGS_CSS}
${MARKDOWN_CSS}
${RICH_COMPOSER_CSS}
${RECORD_CSS}
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
    this.lookupPreviews = new Map();
    this.ui = loadUI();
    // 打开工作台只回看，不自动调用 AI。
    this.tab = 'records';
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
        <div class="grab" id="grab" role="separator" aria-orientation="vertical" tabindex="0" aria-label="调整侧栏宽度" title="拖动或按左右方向键调整宽度；Home 最窄，End 最宽，Enter 复位"></div>
        <header>
          <div class="title">
            <span class="brand">
              <span class="brand-seal">${brandMark()}</span>
              <span class="brand-copy"><span class="brand-name">Context<em>Flow</em></span><span class="brand-sub" id="brandSub">READING MARGIN</span></span>
            </span>
            <span class="r">
              <button class="icon-action" id="library" type="button" title="跨文章搜索、回顾与备份" aria-label="我的阅读库" hidden>${icon('folder')}<span>我的阅读库</span></button>
              <button class="icon-action" id="cfg" title="配置翻译、解释与笔记同步" aria-label="配置">${icon('settings')}<span>配置</span></button>
              <button class="icon-action" id="mode" title="切换面板布局" aria-label="切换面板布局"></button>
            </span>
          </div>
          <div class="tabs" role="tablist">
            ${TABS.map((t) => `<button class="tab" id="t-${t.key}" role="tab" aria-controls="p-${t.key}">${icon(t.icon)}`
              + `<span>${t.label}</span><span class="badge" id="b-${t.key}"></span></button>`).join('')}
          </div>
        </header>
        <aside class="connection-note" id="connectionNote" hidden><strong>批注与导出可直接使用</strong><p id="connectionHint"></p><button id="connectService" type="button">开启 AI / 同步</button></aside>
        <div class="body">
          ${TABS.map((t) => `<div class="pane" id="p-${t.key}" role="tabpanel" aria-labelledby="t-${t.key}">${t.key === 'note'
            ? '<div class="note-head"><strong>你的理解，而非 AI 的回答</strong><span>自动保存</span></div>'
              + '<div class="note" id="note"></div>'
            : t.key === 'brief' ? '<div class="brief" id="brief"></div>' : ''}</div>`).join('')}
          <div class="set" id="p-set"></div>
        </div>
        <div class="undo-notice" id="undoNotice" hidden><span role="status" aria-live="polite">记录已删除</span><button type="button" id="undoDelete">撤销删除</button></div>
        <footer>
          <div class="r">
            <button class="anchor-stat" id="stat" type="button" aria-describedby="stat-tip"></button>
            <span class="foot-actions">
              <button id="copyMd" class="has-tip" type="button" aria-label="复制 Markdown" aria-describedby="copy-tip">${icon('copy')}<span class="label">复制</span><span class="tip" id="copy-tip" role="tooltip">复制当前文章的速览、翻译、解释、批注和总结；无需本地服务。</span></button>
              <button id="downloadMd" class="has-tip" type="button" aria-label="下载 Markdown" aria-describedby="download-tip">${icon('download')}<span class="label">下载</span><span class="tip" id="download-tip" role="tooltip">把当前文章的全部本地记录下载为 Markdown；离线也可用。</span></button>
              <button id="sync" class="has-tip" type="button" aria-label="同步到笔记" aria-describedby="sync-tip">${icon('sync')}<span class="label" id="syncLabel">同步</span><span class="tip" id="sync-tip" role="tooltip">同步到当前配置的 Obsidian 或 Markdown 文件夹。</span></button>
            </span>
          </div>
          <div class="storage-note">编辑自动保存在浏览器；写入笔记软件请点击「同步」。</div>
          <div class="syncmsg" id="syncmsg" role="status" aria-live="polite" aria-atomic="true"></div>
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
    this.$('sync').onclick = this.guard(() => this.doSync());
    this.$('copyMd').onclick = this.guard(async () => { await this.flushEdits(); this.syncMsg(await this.h.onCopyMarkdown(), 'ok'); });
    this.$('downloadMd').onclick = this.guard(async () => { await this.flushEdits(); this.syncMsg(await this.h.onDownloadMarkdown(), 'ok'); });
    this.$('cfg').onclick = this.guard(() => this.h.canConnectService?.() && !this.h.isOnline()
      ? this.h.onOpenConnection?.() : this.toggleSettings());
    this.$('connectService').onclick = this.guard(() => this.h.onOpenConnection?.());
    this.$('library').onclick=this.guard(async()=>{await this.flushEdits();await this.h.onOpenLibrary?.();});
    this.$('mode').onclick = () => this.setMode(this.ui.mode === 'push' ? 'float' : 'push');
    for (const k of TAB_KEYS) {
      const button = this.$(`t-${k}`);
      button.onclick = () => this.select(k);
      button.onkeydown = (e) => {
        const index = TAB_KEYS.indexOf(k);
        const next = e.key === 'ArrowRight' ? (index + 1) % TAB_KEYS.length
          : e.key === 'ArrowLeft' ? (index + TAB_KEYS.length - 1) % TAB_KEYS.length
          : e.key === 'Home' ? 0 : e.key === 'End' ? TAB_KEYS.length - 1 : null;
        if (next === null) return;
        e.preventDefault(); this.select(TAB_KEYS[next]); this.$(`t-${TAB_KEYS[next]}`).focus();
      };
    }

    this.composers = new Map();
    this.lookupComposers = new Map();
    this.records = new RecordList(this, this.$('p-records'));
    this.$('undoDelete').onclick = this.guard(async () => {
      const button = this.$('undoDelete'); button.disabled = true;
      try { const remaining = await this.h.onUndoDelete?.(); this.$('undoNotice').hidden = !remaining; }
      finally { button.disabled = false; }
    });
    this.noteComposer = new RichComposer(this.$('note'), {
      value: this.h.getNote?.() || '',
      placeholder: '记下整体理解、与其他工作的关系，以及仍待验证的问题…',
      onInput: (value) => this.h.onNoteInput?.(value),
      onCommit: (value) => this.h.onNoteChange?.(value),
      onAsset: (file) => this.h.onAsset?.(file),
      resolveAsset: (id) => this.h.resolveAsset?.(id),
    });

    this.wireResize();
    this.$('wrap').addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault(); e.stopPropagation(); this.toggle(false);
    });
    addEventListener('resize', () => this.applyLayout());
    this.select('records');
    this.applyLayout();
    if (this.ui.open) this.toggle(true, false);
  }

  /** 配置界面与阅读工作台互斥显示 */
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
      if (!this.settings) this.settings = new Settings(this.sh, this.$('p-set'), this.h.api, this.h.onBlock,
        { onSaved: () => this.h.onConfigurationSaved?.() });
      this.settings.load();
    }
  }

  async doSync() {
    if (this.h.canConnectService?.() && !this.h.isOnline()) return this.h.onOpenConnection?.();
    if (this.syncing) return;
    this.syncing = true;
    const button = this.$('sync');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const label = this.$('syncLabel');
    label.textContent = '同步中…';
    this.syncMsg('');
    try {
      await this.flushEdits();
      const r = await this.h.onSync();
      // 新增与改写要分开报：只报总数的话，"改了总结再同步"看起来像什么都没发生
      const bits = [r.inserted ? `新增 ${r.inserted}` : null,
        r.updated ? `改写 ${r.updated}` : null,
        r.sourceUpdated ? `更新原文链接 ${r.sourceUpdated}` : null].filter(Boolean);
      label.textContent = bits.length ? '已同步' : '已是最新';
      const where = (r.files || r.docs || []).join('、');
      const backend = { obsidian: 'Obsidian', markdown: 'Markdown', siyuan: '思源笔记' }[r.backend] || '笔记';
      this.syncMsg(where ? `已同步到 ${backend} · ${r.articles} 篇 → ${where}`
        : `${backend} 已是最新，没有需要新增或改写的内容。`, 'ok');
    } catch (e) {
      label.textContent = '同步失败';
      // 原因必须出现在界面上。只 console.error 的话，用户看到的是一个
      // 没有下文的"同步失败"，连"服务没重启"这种一句话就能解决的问题都看不出来。
      this.syncMsg(e.message, 'bad', hintFor(e.message));
      console.error('[ContextFlow] 同步到笔记失败：', e.message);
    } finally {
      this.syncing = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
    clearTimeout(this.syncLabelTimer);
    this.syncLabelTimer = setTimeout(() => { label.textContent = '同步'; }, 2600);
  }

  async flushEdits() {
    const composers = [this.noteComposer, ...this.composers.values(), ...this.lookupComposers.values()];
    if (composers.some(editor => editor?.blocks?.some(block => block.pending || block.error))) {
      throw new Error('图片尚未保存完成或保存失败，请等待完成或移除失败图片后再导出、同步。');
    }
    await Promise.all(composers.map(editor => editor?.commit()));
    await this.h.onFlushEdits?.();
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
    el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  }

  // ---------- 布局 ----------
  clampWidth(w) {
    const viewport = this.viewportWidth();
    return Math.round(viewport < 700
      ? Math.max(Math.min(MIN_W, viewport - 32), Math.min(w, viewport - 40))
      : Math.max(MIN_W, Math.min(w, viewport * MAX_FRAC)));
  }

  viewportWidth() { return globalThis.visualViewport?.width || document.documentElement.clientWidth || innerWidth; }

  /**
   * push 模式给 <html> 加 margin-right，使正文与面板完全不重叠。
   * 注意：position:fixed 的页面元素相对视口定位，不随根元素外边距移动，
   * 因此固定顶栏仍可能被面板压住一角 —— 这是页面内注入方案的固有限制，
   * 真正无损的做法只有浏览器级 side panel（迁到扩展后可用 sidePanel API）。
   * 遇到 push 会搞坏布局的站点，切到 float 模式。
   */
  applyLayout() {
    const w = this.clampWidth(this.ui.width);
    const viewport = this.viewportWidth();
    const narrow = viewport < 700;
    const float = narrow || this.ui.mode === 'float';
    const wrap = this.$('wrap');
    wrap.inert = !this.open;
    wrap.setAttribute('aria-hidden', String(!this.open));
    wrap.style.width = `${w}px`;
    wrap.style.left = `${Math.max(0, viewport - w)}px`;
    wrap.classList.toggle('float', float);
    const grab = this.$('grab');
    grab.setAttribute('aria-valuemin', String(this.clampWidth(0)));
    grab.setAttribute('aria-valuemax', String(this.clampWidth(Infinity)));
    grab.setAttribute('aria-valuenow', String(w));
    grab.setAttribute('aria-valuetext', `${w} 像素`);
    // 同一按钮始终存在：收起时贴视口右缘，展开时贴面板左缘。
    // 它是 wrap 的兄弟，既不会被 overflow 裁切，也不会在手势中换成另一个元素。
    this.$('panelToggle').style.right = this.open ? `${w}px` : '0px';
    this.$('panelToggle').style.left = `${Math.max(0, viewport - (this.open ? w : 0) - 31)}px`;

    const root = document.documentElement;
    if (this.open && !float) {
      if (this.rootMarginBefore === null) {
        this.rootMarginBefore = root.style.marginRight;
        this.rootTransitionBefore = root.style.transition;
      }
      root.style.transition = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? this.rootTransitionBefore || '' : appendTransition(this.rootTransitionBefore, 'margin-right .26s cubic-bezier(.22,.8,.3,1)');
      root.style.marginRight = `${w}px`;
    } else if (this.rootMarginBefore !== null) {
      root.style.transition = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? this.rootTransitionBefore || '' : appendTransition(this.rootTransitionBefore, 'margin-right .26s cubic-bezier(.22,.8,.3,1)');
      root.style.marginRight = this.rootMarginBefore;
      const restore = this.rootTransitionBefore;
      clearTimeout(this._marginTimer);
      this._marginTimer = setTimeout(() => { root.style.transition = restore || ''; }, 280);
      this.rootMarginBefore = null;
      this.rootTransitionBefore = null;
    }
    const modeLabel = this.ui.mode === 'push' ? '挤开正文' : '浮在正文上';
    setButtonContent(this.$('mode'), this.ui.mode === 'push' ? 'dock' : 'float', modeLabel);
    const modeHint = narrow ? '窄窗口自动使用浮层，不改变桌面布局偏好' : this.ui.mode === 'push'
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
    grab.addEventListener('keydown', e => {
      const step=e.shiftKey ? 50 : 20;
      const width=e.key==='ArrowLeft' ? this.ui.width+step : e.key==='ArrowRight' ? this.ui.width-step
        : e.key==='Home' ? 0 : e.key==='End' ? Infinity : e.key==='Enter' ? 360 : null;
      if(width===null)return;
      e.preventDefault();this.ui.width=this.clampWidth(width);this.applyLayout();saveUI(this.ui);
    });
    let startX = 0, startW = 0;
    let previousSelection='';
    const onMove = (e) => {
      // 往左拖变宽：面板贴右缘，所以用 startX - clientX
      this.ui.width = this.clampWidth(startW + (startX - e.clientX));
      this.applyLayout();
    };
    const onUp = (e) => {
      grab.classList.remove('on');
      grab.releasePointerCapture?.(e.pointerId);
      grab.removeEventListener('pointermove', onMove);
      document.documentElement.style.userSelect = previousSelection;
      saveUI(this.ui);
    };
    grab.addEventListener('pointerdown', (e) => {
      if(e.button!==undefined && e.button!==0)return;
      e.preventDefault();
      startX = e.clientX; startW = this.ui.width;
      grab.classList.add('on');
      grab.setPointerCapture?.(e.pointerId);
      // 拖动时禁选，否则会在正文里拉出选区并弹出工具条
      previousSelection=document.documentElement.style.userSelect;
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
    if (!open && this.$('wrap').contains(this.sh.activeElement)) this.$('panelToggle').focus({preventScroll:true});
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
    // Compatibility for original-source marks and integrations using old keys.
    if (['comments', 'explain', 'translate'].includes(tab)) {
      this.records.select(tab); tab = 'records';
    }
    if (!TAB_KEYS.includes(tab)) return;
    this.tab = tab;
    if (this.settingsOpen) this.toggleSettings();     // 切 tab 即退出配置界面
    for (const k of TAB_KEYS) {
      this.$(`t-${k}`).setAttribute('aria-selected', String(k === tab));
      this.$(`t-${k}`).tabIndex = k === tab ? 0 : -1;
      this.$(`p-${k}`).classList.toggle('on', k === tab);
    }
    if (tab === 'note') this.noteComposer?.setValue(this.h.getNote() ?? '');
    else this.render();
  }

  /** 定位到某条批注并聚焦其评论框 */
  focusItem(id) {
    this.toggle(true);
    this.select('records');
    const el = this.records.reveal(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.composers.get(id)?.focus();
  }

  /** 原位编辑器输入时只改现有 textarea，不重建列表，因此焦点与滚动位置都不动。 */
  updateCommentDraft(id, value) {
    this.composers.get(id)?.setValue(String(value ?? ''));
  }

  /** 原文旁的解释面板输入时，镜像到右栏的“我的补充”，不重建解释条目。 */
  updateLookupSupplement(id, value) {
    this.lookupComposers.get(id)?.setValue(String(value ?? ''));
  }

  /** 右栏可见时标出当前正在哪段原文旁编辑；关闭原位编辑器后恢复定位文案。 */
  markCommentEditing(id, on) {
    const el = this.sh.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.classList.toggle('editing', on);
    const state = el.querySelector('.item-head .seq');
    if (!state) return;
    if (on) {
      state.className = 'seq edit-state';
      state.innerHTML = `${icon('sync')}<span>原文旁编辑</span>`;
    } else {
      state.className = 'seq';
      state.innerHTML = el.dataset.orphan === 'true'
        ? '<span class="orphan">未定位</span>' : '原文位置';
    }
  }

  /**
   * 从正文的解释/翻译标记跳进来。
   * 必须先 select(kind) 再查 DOM —— select 会重建整个 pane 的 innerHTML，
   * 先拿到的元素引用随即失效。
   */
  focusLookup(kind, id) {
    this.toggle(true);
    this.select('records');
    const el = this.records.reveal(id);
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
    if (!o) { this.briefState = null; el.className = 'brief'; el.innerHTML = ''; return; }
    el.className = `brief ${o.state === 'ok' ? '' : o.state}`;
    // Polling only updates text, never replaces the cancel button mid-click.
    if (o.state === 'run' && this.briefState === 'run') {
      el.querySelector('.brief-progress').textContent = o.text || '';
      const preview = el.querySelector('.stream-preview');
      if (preview) { preview.textContent = o.partialAnswer || ''; preview.hidden = !o.partialAnswer; }
      return;
    }
    this.briefState = o.state;
    // 运行态给一个脉动点：否则进度文字读起来像最终结果，看不出还在跑
    const dot = o.state === 'run' ? '<span class="dot2"></span>' : '';
    el.innerHTML = `<div class="hd2"><span class="brief-label">${icon('sparkle')}<span>AI 速览</span></span>`
      + `${o.state === 'run' ? '<button data-act="cancel-brief">取消生成</button>' : o.configure ? '<button data-act="configure-ai">配置 AI</button>' : o.retry ? `<button class="with-icon" data-act="rebrief">${icon('retry')}<span>${o.initial ? '生成速览' : '重新生成'}</span></button>` : ''}</div>`
      + `<div class="txt">${dot}</div>${o.state === 'run' ? '<div class="stream-preview" hidden></div>' : ''}${o.previous ? '<div class="previous-brief" style="margin-top:14px"></div>' : ''}`
      + `${o.meta ? `<div class="ft">${esc(o.meta)}</div>` : ''}`;
    const body = el.querySelector('.txt');
    if (o.previous) renderMarkdownInto(el.querySelector('.previous-brief'), o.previous);
    if (o.state === 'run' && o.partialAnswer) {
      const preview = el.querySelector('.stream-preview'); preview.textContent = o.partialAnswer; preview.hidden = false;
    }
    if (o.state === 'ok') renderMarkdownInto(body, o.text || '');
    else { const text = document.createElement('span'); text.className = 'brief-progress'; text.textContent = o.text || ''; body.append(text); }
    const cancel = el.querySelector('[data-act=cancel-brief]');
    if (cancel) cancel.onclick = this.guard(() => this.h.onCancelSummary?.());
    const b = el.querySelector('[data-act=rebrief]');
    if (b) b.onclick = this.guard(() => this.h.onSummarize?.(true));
    const configure = el.querySelector('[data-act=configure-ai]');
    if (configure) configure.onclick = this.guard(() => this.toggleSettings());
  }

  renderStatus() {
    this.$('library').hidden=!this.h.canOpenLibrary?.();
    const s = this.h.getStats(), n = this.h.getItems().length;
    const ok = s.position + s.quote + s.fuzzy;
    const online = this.h.isOnline();
    const box = this.h.outbox();
    const canConnect = this.h.canConnectService?.();
    this.$('connectionNote').hidden = !canConnect || online;
    const unpaired = this.h.getConnectionIssue?.() === 'PAIRING_REQUIRED';
    this.$('connectionHint').textContent = unpaired
      ? 'AI 和笔记同步尚未开启。需要时再连接，不影响本地阅读记录。'
      : '本地服务未连接。记录仍会保存在浏览器，可以复制或下载。';
    this.$('connectService').textContent = unpaired ? '开启 AI / 同步' : '检查连接';
    const main = n ? `已定位 ${ok}/${n}` : '暂无批注';
    const details = n
      ? `精确 ${s.position} · 文本匹配 ${s.quote} · 模糊恢复 ${s.fuzzy}`
        + (s.orphan ? ` · 未定位 ${s.orphan}` : '')
      : '点击重新解析正文锚点';
    this.$('stat').innerHTML = `<span class="stat-main">`
      + `<span class="led${online ? ' online' : ''}"></span><span>${main}</span>`
      + `${s.orphan ? `<span class="warn">未定位 ${s.orphan}</span>` : ''}`
      + `${box ? canConnect && !online ? '<span>本地保存</span>' : `<span class="warn">待发送 ${box}</span>` : ''}</span>`
      + `<span class="stat-tip" id="stat-tip" role="tooltip">${details}<br>`
      + `${canConnect ? online ? '本地服务已连接' : '记录保存在本机；AI 与笔记同步需连接服务' : online ? 'AI 通道可用' : '当前离线'} · 点击重新解析</span>`;
    this.$('gn').textContent = n ? String(n) : '';
    // 总结没有"条数"，用一个克制的琥珀点表示已有内容，不再混用字符"·"。
    const hasBrief = this.h.getLookups('summary').some((e) => e.value);
    const hasNote = !!((this.h.getNote() || '').trim());
    this.$('b-brief').classList.toggle('has-content', hasBrief);
    this.$('b-note').textContent = '';
    this.$('b-note').classList.toggle('has-content', hasNote);
    const ex = this.h.getLookups('explain');
    const running = ex.filter((e) => e.extra?.status === 'running').length;
    // 浮层关掉后，角标仍要诚实地告诉用户有任务在跑；用脉动点而不是“⋯”字符。
    const tr = this.h.getLookups('translate').length;
    this.$('b-records').textContent = n + ex.length + tr || '';
    this.$('b-records').classList.toggle('busy', running > 0);
    this.$('b-records').title = running ? `${running} 条正在生成` : '';
  }

  showUndo(label = '记录已删除') {
    this.$('undoNotice').hidden = false;
    this.$('undoNotice').querySelector('span').textContent = label;
  }

  renderLookups(kind) { this.records.select(kind); }

  /** Keep streamed text outside the event model, exports, and offline storage. */
  renderLookupPreview(id, text = '') {
    if (text) this.lookupPreviews.set(id, text); else this.lookupPreviews.delete(id);
    const record = this.records.views.get(id)?.el;
    if (!record) return;
    let preview = record.querySelector('.stream-preview');
    if (!text) { preview?.remove(); return; }
    if (!preview) {
      preview = document.createElement('div'); preview.className = 'stream-preview';
      record.querySelector('.st').after(preview);
    }
    if (preview.textContent !== text) preview.textContent = text;
  }

  render() {
    this.renderStatus();
    if (this.open && this.tab === 'records') {
      this.records.render();
      for (const [id, text] of this.lookupPreviews) this.renderLookupPreview(id, text);
    }
  }
}

const setButtonContent = (el, iconName, label) => {
  el.innerHTML = `${icon(iconName)}<span>${label}</span>`;
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
