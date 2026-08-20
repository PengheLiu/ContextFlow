// 视觉语言集中在这里，各 UI 组件共用。
//
// 取向：这是一个读论文的工具，界面应该像纸和铅笔，不该像 SaaS 控制台。
// 因此用温暖的中性灰（偏纸感，不是冷灰）、极轻的边框、几乎不可见的阴影。
// 原文用衬线体呼应 arxiv 正文，评论用无衬线体 —— 让「引用」与「我的话」
// 在字形层面就区分开，而不是只靠颜色。

export const T = {
  paper: '#fdfcfa',      // 面板底色，微暖白
  sunk: '#f5f3ef',       // 凹陷区域
  line: '#e7e2d9',       // 边框
  lineSoft: '#efebe3',
  ink: '#1c1a17',        // 正文黑（评论用）
  inkSoft: '#57534c',
  quote: '#918a7c',      // 原文浅色
  accent: '#b45309',     // 琥珀，与高亮色系一致
  ok: '#3f7d3f',
  bad: '#b3261e',
  radius: '10px',
  sans: '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif',
  serif: 'Georgia,"Songti SC","Noto Serif CJK SC",serif',
};

/** 每个 Shadow Root 都要注入的基础样式 */
export const BASE = `
  :host{all:initial}
  *,*::before,*::after{box-sizing:border-box}
  .r{display:flex;align-items:center;gap:6px}
  button{all:unset;cursor:pointer;font:inherit;border-radius:7px;padding:5px 9px;
         color:${T.inkSoft};transition:background .12s,color .12s}
  button:hover{background:${T.sunk};color:${T.ink}}
  button:active{transform:translateY(.5px)}
  .muted{color:${T.quote};font-size:11.5px}
  .ok{color:${T.ok}} .bad{color:${T.bad}}
  ::-webkit-scrollbar{width:9px}
  ::-webkit-scrollbar-thumb{background:${T.line};border-radius:5px;
    border:3px solid ${T.paper};background-clip:padding-box}
  ::-webkit-scrollbar-thumb:hover{background:#d8d2c6;background-clip:padding-box}
`;

/** 浮层卡片（工具条、翻译气泡） */
export const FLOAT = `
  .card{position:fixed;background:${T.paper};color:${T.ink};
        font:13px/1.5 ${T.sans};border:1px solid ${T.line};
        border-radius:${T.radius};padding:5px;
        box-shadow:0 1px 2px rgba(28,26,23,.05),0 8px 24px -6px rgba(28,26,23,.18)}
`;

export function shadowHost(name, css, z = 2147483646) {
  const el = document.createElement('div');
  el.setAttribute('data-contextflow', name);   // 锚定索引据此跳过我们自己的 UI
  el.style.cssText = `position:fixed;z-index:${z};top:0;left:0`;
  document.documentElement.appendChild(el);
  const sh = el.attachShadow({ mode: 'open' });
  sh.innerHTML = `<style>${BASE}${css}</style>`;
  return sh;
}
