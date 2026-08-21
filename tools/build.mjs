// 一份源码 → 两个产物：
//   npm run build:skill  → dist/skill.js        userscript（单文件 IIFE，粘贴即用）
//   npm run build:ext    → extension/dist/      Chrome MV3 扩展
//
// 两者共用整个 src/，唯一差别是传输层：userscript 直接 fetch 并把 token 编译进产物；
// 扩展把请求转给 service worker，**token 只注入 sw.js**。
import esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 从本地配置读出 token 编译进产物，省去手抄。
// 当 allowAnyOrigin 打开时，X-ContextFlow 的强制预检不再拦任何 origin，
// token 就成了唯一防线 —— 因此这一步不是便利，而是必需。
// CONTEXTFLOW_DIR 与 server/config.mjs 保持同一套覆盖 —— 否则测试指了临时目录，
// 构建却还在读真实配置，"token 有没有编译进去"这类断言会变成假阴性（踩过）。
const CF_DIR = process.env.CONTEXTFLOW_DIR || join(homedir(), '.contextflow');
let token = '';
try {
  token = JSON.parse(readFileSync(join(CF_DIR, 'config.json'), 'utf8')).token || '';
} catch { /* 未初始化过服务：留空，服务端 requireToken=false 时不校验 */ }

const EXT = process.argv.includes('--ext');

const common = {
  bundle: true,
  charset: 'utf8',
  legalComments: 'none',
  target: 'chrome111',            // world:"MAIN" 与 MV3 的下限；ISOLATED 路径更低也行
};

if (EXT) await buildExtension();
else await buildUserscript();

async function buildExtension() {
  mkdirSync('extension/dist', { recursive: true });

  // 稳定的扩展 id：不写 key 的话 id 由目录路径派生，移动目录或换机器就变，
  // 服务端 allowedOrigins 里的白名单会立刻失效。
  const keyPath = 'extension/key.pub';
  if (!existsSync(keyPath)) {
    throw new Error(`缺少 ${keyPath}。生成一次：见 README 的「扩展」一节`);
  }
  const key = readFileSync(keyPath, 'utf8').trim();
  const der = Buffer.from(key, 'base64');
  const h = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

  // content script：**不注入 token**。它跑在页面上，token 一旦编译进来就等于
  // 回到 userscript 的处境。test/extbuild.test.mjs 断言这一点。
  const ui = await esbuild.build({
    ...common,
    entryPoints: ['src/ext/app.js'],
    outfile: 'extension/dist/app.js',
    format: 'iife',
    define: { __CONTEXTFLOW_TOKEN__: '""' },
    metafile: true,
  });

  // service worker：唯一持有 token 的地方
  const sw = await esbuild.build({
    ...common,
    entryPoints: ['extension/sw.js'],
    outfile: 'extension/dist/sw.js',
    format: 'esm',
    define: { __CONTEXTFLOW_TOKEN__: JSON.stringify(token) },
    metafile: true,
  });

  writeFileSync('extension/dist/manifest.json', `${JSON.stringify({
    manifest_version: 3,
    name: 'ContextFlow',
    version: '0.1.0',
    description: '划词翻译 / 解释 / 高亮批注 / 全文总结，一键同步到你自己的笔记库。',
    key,
    minimum_chrome_version: '111',
    permissions: ['storage'],
    host_permissions: ['http://127.0.0.1:7317/*'],
    background: { service_worker: 'sw.js', type: 'module' },
    action: {
      default_title: 'ContextFlow：开合面板',
      // 工具栏图标用紧贴边界的那套（assets/toolbar-*.png）。
      // icon-512 是给应用/扩展管理页的构图：有圆角底和大留白，塞进工具栏 16px
      // 的格子里墨迹只占 31% 高度、底色又接近白色，实测就是"又小又淡"。
      // 多尺寸是必需的：Chrome 按 DPI 挑，只给大图会被降采样糊掉。
      default_icon: {
        16: 'toolbar-16.png',
        32: 'toolbar-32.png',
        48: 'toolbar-48.png',
        128: 'toolbar-128.png',
      },
    },
    icons: { 48: 'toolbar-48.png', 128: 'icon-512.png' },
    content_scripts: [{
      matches: ['http://*/*', 'https://*/*'],
      // 不写 world → 默认 ISOLATED。已实测那里的 CSS.highlights 能正常绘制，
      // 所以整套 UI 都留在 ISOLATED，页面 JS 碰不到我们的任何东西。
      js: ['app.js'],
      run_at: 'document_idle',
      all_frames: false,
    }],
  }, null, 2)}\n`);

  for (const f of ['icon-512.png', 'toolbar-16.png', 'toolbar-32.png',
    'toolbar-48.png', 'toolbar-128.png']) {
    if (existsSync(`assets/${f}`)) copyFileSync(`assets/${f}`, `extension/dist/${f}`);
    else console.warn(`  ⚠ 缺 assets/${f} —— 先跑 node tools/gen-assets.mjs --png`);
  }

  const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
  console.log(`extension/dist/app.js  ${kb(ui.metafile.outputs['extension/dist/app.js'].bytes)}`);
  console.log(`extension/dist/sw.js   ${kb(sw.metafile.outputs['extension/dist/sw.js'].bytes)}`);
  console.log(`扩展 id  ${id}`);
  console.log(`把这一行加进 ~/.contextflow/config.json 的 allowedOrigins，然后可以关掉 allowAnyOrigin：`);
  console.log(`  "chrome-extension://${id}"`);
}

async function buildUserscript() {
mkdirSync('dist', { recursive: true });

const config = {
  entryPoints: ['src/skill/entry.js'],
  outfile: 'dist/skill.js',
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  charset: 'utf8',
  legalComments: 'none',
  define: { __CONTEXTFLOW_TOKEN__: JSON.stringify(token) },
  banner: {
    js: '// ContextFlow — 粘贴进 userscript 宿主（Tampermonkey 等），绑定目标页面后运行。\n'
      + '// 划词出现颜色条 → 点色块高亮 → 刷新页面应原位重现。右上角状态条显示各层命中数。',
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('watching src/ … (Ctrl-C 退出)');
} else {
  const r = await esbuild.build({ ...config, metafile: true });
  const out = r.metafile.outputs['dist/skill.js'];
  console.log(`dist/skill.js  ${(out.bytes / 1024).toFixed(1)} KB`);
}
}
