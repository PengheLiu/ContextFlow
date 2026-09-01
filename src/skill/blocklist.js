// 停用名单：在不适合划词的页面 / 站点上把整个插件关掉。
//
// 起因：这是个划词工具，但用户并不是只在阅读页停留 —— 在管理后台、Web IDE 里
// 双击选中一个词，工具条照样弹出来挡在半路。误触的成本必须能用「一键关掉」对冲，
// 否则工具越顺手，越招人烦。
//
// 名单存 localStorage（contextflow:blocklist），不进服务端、不进笔记库：
//   · 「这一页要不要工具条」是纯粹的本地偏好，没有跨设备同步的价值；
//   · localStorage 本就按 origin 隔离，「整个站点停用」写进该站点自己的存储，
//     语义与存储边界恰好重合。代价是 www./裸域、http/https 各算一个站点，各停各的。
//
// 恢复路径刻意只在用户主动出手时出现：重新执行userscript（开面板的那一下）、
// 或扩展载体点工具栏图标 —— 都会弹出「已停用」小卡片，带「恢复」按钮。
// 页面加载时绝不弹任何东西，否则停用本身就成了新的打扰。

import { urlKey } from '../core/urlkey.js';
import { T, FLOAT, shadowHost } from './theme.js';
import { icon } from './icons.js';

const KEY = 'contextflow:blocklist';

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
};
const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 配额 */ } };

/** 站点显示名：去掉协议前缀，比裸 origin 亲切一点 */
export function siteLabel(href = location.href) {
  try { return new URL(href).origin.replace(/^https?:\/\//, ''); } catch { return String(href); }
}

/**
 * 当前页面是否被停用。
 * @returns {'site'|'page'|null} 站点级优先 —— 页面名单再长也盖不过整站停用
 */
export function blockedScope(href = location.href) {
  const list = read();
  if (list.site) return 'site';
  return list.pages && list.pages[urlKey(href)] ? 'page' : null;
}

export function blockPage(href = location.href) {
  const list = read();
  list.pages = { ...list.pages, [urlKey(href)]: Date.now() };
  write(list);
}

export function blockSite() {
  write({ ...read(), site: Date.now() });
}

export function unblockPage(href = location.href) {
  const list = read();
  if (!list.pages) return;
  delete list.pages[urlKey(href)];
  write(list);
}

/** 设置页用：按名单里存的 key 直接移除（那是归一化后的 urlKey，不是原始 URL） */
export function unblockPageKey(key) {
  const list = read();
  if (!list.pages || !(key in list.pages)) return;
  delete list.pages[key];
  write(list);
}

export function unblockSite() {
  const list = read();
  delete list.site;
  write(list);
}

/**
 * 设置页用：本 origin 名下全部生效中的规则。
 * 注意站点级为 true 时插件根本不会启动、设置页无从打开 —— 所以界面上能看到的
 * 永远只有「其他页面」这一种条目，站点级的解除只能走恢复卡片（见 showUnblockChip）。
 */
export function blocklistEntries() {
  const list = read();
  return {
    site: !!list.site,
    pages: Object.entries(list.pages || {}).map(([key, at]) => ({ key, at })),
  };
}

// ---------- 恢复卡片 ----------

const CHIP_CSS = `${FLOAT}
  .chip{display:flex;align-items:center;gap:10px;position:fixed;right:16px;bottom:16px;
        padding:8px 9px 8px 13px;border-radius:9px;max-width:min(360px,calc(100vw - 32px))}
  .chip .txt{min-width:0}
  .chip .txt b{display:block;font-size:12.5px;font-weight:650;color:${T.ink}}
  .chip .txt span{display:block;margin-top:1px;font-size:11.5px;color:${T.quote};line-height:1.5}
  .chip .restore{flex:0 0 auto;border:1px solid ${T.accent};color:${T.accent};font-weight:640}
  .chip .restore:hover{background:${T.accentSoft};color:${T.accent}}
  .chip .close{flex:0 0 auto}
`;

const CHIP_HOST = 'unblock-chip';
let chipTimer = null;

/**
 * 「已停用」小卡片：既是就地停用那一刻的确认，也是日后唯一的恢复入口。
 * 8 秒后自动消失 —— 它是通知，不是常驻状态；想再看到它，
 * 重新执行一次userscript / 点一次扩展图标即可。
 * @param {'site'|'page'} scope
 */
export function showUnblockChip(scope = blockedScope() || 'page') {
  document.querySelector(`[data-contextflow="${CHIP_HOST}"]`)?.remove();
  const sh = shadowHost(CHIP_HOST, CHIP_CSS, 2147483647);
  sh.innerHTML += `<div class="chip card" role="status">
    <div class="txt">
      <b>ContextFlow ${scope === 'site' ? `已在 ${siteLabel()} 整站停用` : '已在此页面停用'}</b>
      <span>划词工具条、面板与标记已关闭；重新运行脚本或点扩展图标可再打开本提示</span>
    </div>
    <button class="restore with-icon" type="button">${icon('retry')}<span>恢复</span></button>
    <button class="close icon-btn" type="button" aria-label="关闭提示">${icon('close')}</button>
  </div>`;

  const host = sh.host;
  sh.querySelector('.restore').onclick = () => {
    // 两级都清：既然点了恢复，就不留半截规则（比如页面在整站名单里也有一行）
    unblockPage();
    unblockSite();
    // 插件没有原地重启的能力，刷新是最诚实的恢复方式
    location.reload();
  };
  const dismiss = () => { clearTimeout(chipTimer); host.remove(); };
  sh.querySelector('.close').onclick = dismiss;
  clearTimeout(chipTimer);
  chipTimer = setTimeout(dismiss, 8000);
}

// ---------- 工具条上的「停用」菜单 ----------

const MENU_CSS = `${FLOAT}
  .menu{display:none;flex-direction:column;min-width:238px}
  .menu.on{display:flex}
  .menu button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;
               padding:8px 10px;text-align:left}
  .menu b{font-size:12.5px;font-weight:650;color:${T.ink}}
  .menu span{font-size:11.5px;color:${T.quote};line-height:1.5}
  .menu .rule{height:1px;margin:4px 2px;background:${T.line}}
`;

/**
 * 划词工具条末端的「停用」菜单。交互对齐 MarkDeleteControl：
 * 单例 fixed 定位、按锚点矩形临时摆放、点外面 / Esc / 滚动收起。
 * 走 mousedown 而不是 click —— 工具条按钮全靠 preventDefault 保住选区，
 * 这里保持同一手势习惯。
 */
export class BlockControl {
  /** @param {(scope:'page'|'site')=>void} onBlock 用户选定停用范围后回调 */
  constructor(onBlock) {
    const sh = shadowHost('block-menu', MENU_CSS, 2147483647);
    sh.innerHTML += `<div class="menu card" id="m" role="menu" aria-label="停用 ContextFlow">
      <button type="button" role="menuitem" data-scope="page">
        <b>仅在此页面停用</b><span>本页关闭工具条、面板与标记；其他页面不受影响</span></button>
      <div class="rule" aria-hidden="true"></div>
      <button type="button" role="menuitem" data-scope="site">
        <b>在整个站点停用</b><span>${siteLabel()} 下的页面都不再启动（www 与裸域各算一站）</span></button>
    </div>`;
    this.el = sh.getElementById('m');
    this.openedAt = 0;
    this.el.addEventListener('mousedown', (e) => {
      const b = e.target.closest?.('button[data-scope]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      onBlock?.(b.dataset.scope);
    });
    document.addEventListener('click', (e) => {
      if (!this.visible) return;
      if (performance.now() - this.openedAt < 400) return;   // 打开它的同一次 click
      if (e.target?.closest?.('[data-contextflow]')) return;
      this.hide();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });
    addEventListener('scroll', () => this.hide(), { passive: true });
  }

  /** 摆到触发按钮下方；下方放不下再翻到上方 */
  show(rect) {
    if (!rect) return;
    this.openedAt = performance.now();
    this.el.classList.add('on');
    const box = this.el.getBoundingClientRect();
    const width = box.width || 238, height = box.height || 110;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, innerWidth - width - 8));
    const below = rect.bottom + 8;
    const top = below + height <= innerHeight - 8 ? below : Math.max(8, rect.top - height - 8);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  hide() { this.el?.classList.remove('on'); }

  get visible() { return !!this.el?.classList.contains('on'); }
}
