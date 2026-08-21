// 品牌资源生成器。
//
// 标记的几何只在这里定义一次 —— 之前 mark/logo/logo-dark/icon 各存了一份
// 相同路径，改一处就会走形。
//
// 用法：node tools/gen-assets.mjs        生成 SVG
//      node tools/gen-assets.mjs --png  再渲染 PNG（需要本机装了 Chrome）
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const C = {
  paper: '#fdfcfa',
  line: '#e7e2d9',
  quiet: '#bdb4a1',   // 未高亮的文字行
  accent: '#b45309',
  ink: '#57534c',
  sub: '#918a7c',
  // 深色底变体
  dQuiet: '#7d766a', dAccent: '#e08b2f', dInk: '#eae4d8', dSub: '#a89f8d',
};

/**
 * 标记：三行文字，被划亮的那行最长、冲出段落并带箭头。
 * 语义 = 高亮不停留在原地，它流出去。
 * 注意琥珀横线止于 x=17.5：再短会在箭头正中留出一道缝，
 * 再长圆头会卡在两翼之间、大尺寸下鼓包。这个值是量出来的。
 */
const mark = ({ quiet, accent }) => `
    <path d="M4 6.5h12"  stroke="${quiet}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M4 17.5h9"  stroke="${quiet}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M4 12h13.5" stroke="${accent}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M16.3 9.2 19.8 12l-3.5 2.8" stroke="${accent}" stroke-width="2.4"
          stroke-linecap="round" stroke-linejoin="round"/>`;

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const SANS_CJK = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif";

const files = {
  'mark.svg': `<!-- ContextFlow 标记（几何定义见 tools/gen-assets.mjs，勿手改） -->
<svg width="24" height="24" viewBox="0 0 24 24" fill="none"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ContextFlow">${mark(C)}
</svg>
`,

  'logo.svg': logo(C.quiet, C.accent, C.ink, C.sub, '浅色底'),
  'cover.svg': cover({ bg: '#15120e', quiet: '#6b6459', accent: C.dAccent,
                       ink: C.dInk, sub: C.dSub, hint: '#7d7466' }),
  'cover-light.svg': cover({ bg: C.paper, quiet: C.quiet, accent: C.accent,
                             ink: C.ink, sub: C.sub, hint: '#a49b89' }),
  'logo-dark.svg': logo(C.dQuiet, C.dAccent, C.dInk, C.dSub, '深色底'),

  'icon.svg': `<!-- ContextFlow 方形图标：头像 / favicon / 应用图标（勿手改） -->
<svg width="512" height="512" viewBox="0 0 512 512" fill="none"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ContextFlow">
  <rect width="512" height="512" rx="112" fill="${C.paper}"/>
  <rect x="4" y="4" width="504" height="504" rx="108" stroke="${C.line}" stroke-width="8"/>
  <g transform="translate(112 112) scale(12)">${mark(C)}
  </g>
</svg>
`,

  /**
   * 浏览器工具栏图标。与 icon.svg 的区别是**紧贴边界**。
   *
   * icon.svg 给头像 / 应用图标用，有圆角底和大留白 —— 那种构图放进工具栏 16px 的
   * 格子里，墨迹只占 26% 高度，加上近白色底在工具栏上等于透明，结果就是"又小又淡"
   * （实测如此）。这里把同一套几何放大 1.2022 倍并居中，墨迹横向占 92%、纵向 66%
   * （标记本身宽高比 1.39，方形画布里纵向必然留白）。
   *
   * 灰线改用更深的 sub 色：16px 下 #bdb4a1 在浅色工具栏上几乎看不见。
   */
  'toolbar.svg': `<!-- ContextFlow 工具栏图标（几何见上方 mark，勿手改） -->
<svg width="24" height="24" viewBox="0 0 24 24" fill="none"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ContextFlow">
  <g transform="translate(-2.25 -2.43) scale(1.2022)">${mark({ quiet: C.sub, accent: C.accent })}
  </g>
</svg>
`,
};

function logo(quiet, accent, ink, sub, variant) {
  return `<!-- ContextFlow 横版标志 · ${variant}（勿手改，见 tools/gen-assets.mjs） -->
<svg width="360" height="84" viewBox="0 0 360 84" fill="none"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ContextFlow — 让阅读留下痕迹">
  <g transform="translate(12 20) scale(1.85)">${mark({ quiet, accent })}
  </g>
  <text x="72" y="46" font-family="${SANS}" font-size="31" font-weight="600" letter-spacing="-0.4">
    <tspan fill="${ink}">Context</tspan><tspan fill="${accent}">Flow</tspan>
  </text>
  <text x="73" y="67" font-family="${SANS_CJK}" font-size="13.5"
        fill="${sub}" letter-spacing="1">让阅读留下痕迹</text>
</svg>
`;
}

/**
 * 参赛页封面图。
 *
 * 平台会自动裁切：列表预览 16:9、展开详情 5:2。
 * 因此按 16:9（1920×1080）出图，并把全部内容收进中心的 5:2 安全区
 * ——即 y ∈ [156, 924]。反过来按 5:2 出图的话，16:9 视图会切掉左右各 14%，
 * 字标必被切。
 *
 * 内容整体包在一个 <g> 里，垂直居中只靠 SHIFT 一个数调，
 * 避免四个元素各调一次导致对不齐。
 * 不加背景纹理：试过放大母题压低透明度，渲染出来像脏点，反而显得没做完。
 */
function cover({ bg, quiet, accent, ink, sub, hint }) {
  const SHIFT = -46;   // 内容块中心 → 画布中心 y=540
  return `<!-- ContextFlow 参赛封面 16:9（勿手改，见 tools/gen-assets.mjs） -->
<svg width="1920" height="1080" viewBox="0 0 1920 1080" fill="none"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ContextFlow — 让阅读留下痕迹">
  <rect width="1920" height="1080" fill="${bg}"/>
  <g transform="translate(0 ${SHIFT})">
    <g transform="translate(468 404) scale(11.4)">${mark({ quiet, accent })}
    </g>
    <text x="770" y="512" font-family="${SANS}" font-size="132"
          font-weight="600" letter-spacing="-3">
      <tspan fill="${ink}">Context</tspan><tspan fill="${accent}">Flow</tspan>
    </text>
    <text x="776" y="622" font-family="${SANS_CJK}" font-size="52"
          fill="${sub}" letter-spacing="6">让阅读留下痕迹</text>
    <text x="960" y="754" text-anchor="middle" font-family="${SANS_CJK}"
          font-size="34" fill="${hint}" letter-spacing="1.5">划词翻译 · 高亮 · 批注 → 你自己的笔记库 → 交给 Agent 加工</text>
  </g>
</svg>
`;
}

mkdirSync('assets', { recursive: true });
for (const [name, body] of Object.entries(files)) {
  writeFileSync(`assets/${name}`, body);
  console.log(`  assets/${name}`);
}

if (!process.argv.includes('--png')) {
  console.log('\n加 --png 可一并渲染 PNG');
  process.exit(0);
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);

if (!CHROME) {
  console.error('未找到 Chrome/Chromium，跳过 PNG 渲染（SVG 已生成）');
  process.exit(0);
}

// headless 截图：透明底，靠 device-scale-factor 出高清图
const shots = [
  ['cover.svg', 'cover.png', 1920, 1080, 1],
  ['cover-light.svg', 'cover-light.png', 1920, 1080, 1],
  ['logo.svg', 'logo.png', 360, 84, 3],
  ['logo-dark.svg', 'logo-dark.png', 360, 84, 3],
  ['icon.svg', 'icon-512.png', 512, 512, 1],
  ['mark.svg', 'mark-240.png', 24, 24, 10],
  // 工具栏图标要多尺寸：Chrome 按 DPI 与位置挑，只给一个大图会被降采样糊掉
  ['toolbar.svg', 'toolbar-16.png', 24, 24, 16 / 24],
  ['toolbar.svg', 'toolbar-32.png', 24, 24, 32 / 24],
  ['toolbar.svg', 'toolbar-48.png', 24, 24, 2],
  ['toolbar.svg', 'toolbar-128.png', 24, 24, 128 / 24],
];
for (const [src, out, w, h, dpr] of shots) {
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--default-background-color=00000000',
    `--force-device-scale-factor=${dpr}`,
    `--window-size=${w},${h}`,
    `--screenshot=assets/${out}`,
    `file://${process.cwd()}/assets/${src}`,
  ], { stdio: 'ignore' });
  console.log(`  assets/${out}  ${w * dpr}x${h * dpr}`);
}
