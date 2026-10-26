// 视觉语言集中在这里，各 UI 组件共用。
//
// 取向：这是一个读论文的工具，界面应该像纸和铅笔，不该像 SaaS 控制台。
// 因此用温暖的中性灰（偏纸感，不是冷灰）、极轻的边框、克制的层次。
// 原文用衬线体呼应论文正文，评论用无衬线体 —— 让「引用」与「我的话」
// 在字形层面就区分开，而不是只靠颜色。
//
// 颜色全部经 CSS variable 间接引用：亮色是日间纸张，暗色是暖炭灰的「夜间纸张」，
// 不是纯黑控制台。注入页面时优先跟随网页本身的明暗，系统主题只作为无法判断时的兜底。

import { FONTS, RADII, themeCSS } from '../core/design-tokens.js';

export const T = {
  paper: 'var(--cf-paper)',
  paperRaised: 'var(--cf-paper-raised)',
  sunk: 'var(--cf-sunk)',
  sunkHover: 'var(--cf-sunk-hover)',
  line: 'var(--cf-line)',
  lineSoft: 'var(--cf-line-soft)',
  lineStrong: 'var(--cf-line-strong)',
  ink: 'var(--cf-ink)',
  inkSoft: 'var(--cf-ink-soft)',
  quote: 'var(--cf-quote)',
  placeholder: 'var(--cf-placeholder)',
  accent: 'var(--cf-accent)',
  accentHover: 'var(--cf-accent-hover)',
  onAccent: 'var(--cf-on-accent)',
  accentSoft: 'var(--cf-accent-soft)',
  accentWash: 'var(--cf-accent-wash)',
  ok: 'var(--cf-ok)',
  okSoft: 'var(--cf-ok-soft)',
  okLine: 'var(--cf-ok-line)',
  bad: 'var(--cf-bad)',
  badSoft: 'var(--cf-bad-soft)',
  focusLine: 'var(--cf-focus-line)',
  focusRing: 'var(--cf-focus-ring)',
  hover: 'var(--cf-hover)',
  shadowFloat: 'var(--cf-shadow-float)',
  shadowPanel: 'var(--cf-shadow-panel)',
  shadowControl: 'var(--cf-shadow-control)',
  blue: 'var(--cf-blue)',
  blueSoft: 'var(--cf-blue-soft)',
  radius: RADII.card,
  sans: FONTS.sans,
  serif: FONTS.serif,
  mono: FONTS.mono,
};

/** 每个 Shadow Root 都要注入的基础样式 */
export const BASE = `
  :host{all:initial}
  ${themeCSS(':host', { systemDark: true })}
  *,*::before,*::after{box-sizing:border-box}
  .r{display:flex;align-items:center;gap:6px}
  .ico{display:block;width:16px;height:16px;flex:0 0 auto;overflow:visible}
  .with-icon{display:inline-flex;align-items:center;justify-content:center;gap:5px}
  .icon-btn{display:grid;place-items:center;width:28px;height:28px;padding:0}
  button{all:unset;box-sizing:border-box;cursor:pointer;font:inherit;border-radius:7px;padding:5px 9px;
         color:${T.inkSoft};transition:background .14s ease,color .14s ease,border-color .14s ease,transform .1s ease}
  button:hover{background:${T.hover};color:${T.ink}}
  button:active{transform:translateY(.5px)}
  button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{
    outline:2px solid ${T.focusLine};outline-offset:2px}
  button:disabled{cursor:default;opacity:.5}
  .muted{color:${T.quote};font-size:12px}
  .ok{color:${T.ok}} .bad{color:${T.bad}}
  ::selection{background:${T.accentSoft}}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:var(--cf-scroll);border-radius:6px;
    border:3px solid ${T.paper};background-clip:padding-box}
  ::-webkit-scrollbar-thumb:hover{background:var(--cf-scroll-hover);background-clip:padding-box}
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;
      animation-iteration-count:1!important;transition-duration:.01ms!important}
  }
`;

/** 浮层卡片（工具条、翻译气泡） */
export const FLOAT = `
  .card{position:fixed;background:${T.paper};color:${T.ink};
        font:13px/1.55 ${T.sans};border:1px solid ${T.line};
        border-radius:${T.radius};padding:5px;box-shadow:${T.shadowFloat};
        -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
`;

// 注入式 UI 不能只看系统主题：用户可能系统深色、网页却明确使用浅色主题。
// 先读取页面实际画布颜色；只有页面没有可判定背景时，才回退到 prefers-color-scheme。
const themeHosts = new Set();
let themeWatchReady = false;
let themeFrame = 0;

export function pageTheme() {
  const parse = (value) => {
    const m = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const raw = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (raw.length < 3) return null;
    const channel = (v) => String(v).endsWith('%') ? Number.parseFloat(v) * 2.55 : Number(v);
    const alpha = raw[3] == null ? 1 : (String(raw[3]).endsWith('%')
      ? Number.parseFloat(raw[3]) / 100 : Number(raw[3]));
    if (!Number.isFinite(alpha) || alpha < .08) return null;
    const linear = raw.slice(0, 3).map(channel).map((n) => {
      const c = Math.max(0, Math.min(255, n)) / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    });
    if (linear.some((n) => !Number.isFinite(n))) return null;
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] < .26 ? 'dark' : 'light';
  };

  // body / html 是网页画布最可靠的信号；透明时再看视口中央真正承载正文的元素。
  const candidates = [document.body, document.documentElement];
  if (typeof document.elementsFromPoint === 'function') {
    const points = [[innerWidth / 2, innerHeight / 2], [Math.min(24, innerWidth / 2), Math.min(24, innerHeight / 2)]];
    for (const [x, y] of points) {
      for (const node of document.elementsFromPoint(x, y)) {
        if (node?.closest?.('[data-contextflow]')) continue;
        for (let cur = node; cur && cur !== document; cur = cur.parentElement) candidates.push(cur);
      }
    }
  }
  // getComputedStyle 是 window 上的全局，宿主环境（部分测试替身、特殊沙箱）可能没有：
  // 拿不到实测背景就跳过这一级，走 colorScheme / matchMedia 兜底。
  if (typeof getComputedStyle === 'function') {
    for (const node of [...new Set(candidates)]) {
      if (!node) continue;
      const tone = parse(getComputedStyle(node).backgroundColor);
      if (tone) return tone;
    }
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    if (/\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)) return 'dark';
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}

const themeListeners = new Set();

/**
 * 订阅页面明暗变化。除了 Shadow Host 自己，正文里的高亮 / 查询标记
 * 也画在页面上，同样要跟这个判定源走（见 highlight.js 的 setDark）。
 * 订阅时立即以当前值回调一次；返回取消函数。
 */
export function onPageTheme(cb) {
  themeListeners.add(cb);
  cb(pageTheme());
  return () => themeListeners.delete(cb);
}

function refreshThemeHosts() {
  themeFrame = 0;
  const tone = pageTheme();
  for (const host of themeHosts) host.dataset.theme = tone;
  // 订阅方抛异常不该打断其他 host / 订阅方的更新
  for (const cb of themeListeners) { try { cb(tone); } catch { /* 各自负责 */ } }
}

function watchTheme(host) {
  themeHosts.add(host);
  refreshThemeHosts();
  if (themeWatchReady) return;
  themeWatchReady = true;
  const schedule = () => {
    if (themeFrame) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    themeFrame = raf(refreshThemeHosts);
  };
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  }
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', schedule);
}

/** Retired SPA UI must not remain retained by the page-wide theme observer. */
export function releaseThemeHost(host) { themeHosts.delete(host?.host || host); }

export function shadowHost(name, css, z = 2147483646) {
  const el = document.createElement('div');
  el.setAttribute('data-contextflow', name);   // 锚定索引据此跳过我们自己的 UI
  el.style.cssText = `position:fixed;z-index:${z};top:0;left:0`;
  document.documentElement.appendChild(el);
  watchTheme(el);
  const sh = el.attachShadow({ mode: 'open' });
  sh.innerHTML = `<style>${BASE}${css}</style>`;
  return sh;
}
