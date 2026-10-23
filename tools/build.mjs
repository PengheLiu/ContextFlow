// 一份源码 → 两个产物：
//   npm run build:skill  → dist/skill.js        userscript（单文件 IIFE，粘贴即用）
//   npm run build:ext    → extension/dist/      Chrome MV3 扩展
//
// 两者共用整个 src/，唯一差别是传输层：userscript 直接 fetch 并把 token 编译进产物；
// 扩展把请求转给 service worker，**token 只注入 sw.js**。
import esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { markdownLicenseComment } from './markdown-licenses.mjs';
import { assertExtensionText } from './extension-text.mjs';

const EXT = process.argv.includes('--ext');
const PUBLIC_SKILL = process.argv.includes('--public');
const STORE = EXT && process.argv.includes('--store');

// 从本地配置读出 token 编译进产物，省去手抄。
// 当 allowAnyOrigin 打开时，X-ContextFlow 的强制预检不再拦任何 origin，
// token 就成了唯一防线 —— 因此这一步不是便利，而是必需。
// CONTEXTFLOW_DIR 与 server/config.mjs 保持同一套覆盖 —— 否则测试指了临时目录，
// 构建却还在读真实配置，"token 有没有编译进去"这类断言会变成假阴性（踩过）。
const CF_DIR = process.env.CONTEXTFLOW_DIR || join(homedir(), '.contextflow');
let token = '';
try {
  if (!STORE && !PUBLIC_SKILL) {
    token = JSON.parse(readFileSync(join(CF_DIR, 'config.json'), 'utf8')).token || '';
  }
} catch { /* 未初始化过服务：留空，服务端 requireToken=false 时不校验 */ }

// 测试构建必须写临时目录，绝不能覆盖开发者实际加载的 extension/dist。
// test/extbuild.test.mjs 会通过此变量隔离假 token 产物。
const EXT_DIR = process.env.CONTEXTFLOW_EXT_DIR || (STORE ? 'release/chrome-extension' : 'extension/dist');

const common = {
  bundle: true,
  // KaTeX contains U+FFFF in a regex boundary string. Raw UTF-8 passes ordinary
  // decoders but Chromium rejects noncharacters when loading content scripts.
  // ASCII output preserves runtime strings through JavaScript Unicode escapes.
  charset: 'ascii',
  legalComments: 'none',
  target: 'chrome111',            // world:"MAIN" 与 MV3 的下限；ISOLATED 路径更低也行
};

if (EXT) await buildExtension();
else await buildUserscript();

async function buildExtension() {
  mkdirSync(EXT_DIR, { recursive: true });

  // 稳定的扩展 id：不写 key 的话 id 由目录路径派生，移动目录或换机器就变，
  // 服务端 allowedOrigins 里的白名单会立刻失效。
  const keyPath = 'extension/key.pub';
  if (!STORE && !existsSync(keyPath)) {
    throw new Error(`缺少 ${keyPath}。生成一次：见 README 的「扩展」一节`);
  }
  const key = STORE ? '' : readFileSync(keyPath, 'utf8').trim();
  const der = Buffer.from(key, 'base64');
  const h = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

  // content script：**不注入 token**。它跑在页面上，token 一旦编译进来就等于
  // 回到 userscript 的处境。test/extbuild.test.mjs 断言这一点。
  const ui = await esbuild.build({
    ...common,
    entryPoints: ['src/ext/app.js'],
    outfile: join(EXT_DIR, 'app.js'),
    format: 'iife',
    define: { __CONTEXTFLOW_TOKEN__: '""' },
    metafile: true,
    banner: { js: markdownLicenseComment() },
  });

  // service worker：唯一持有 token 的地方
  const sw = await esbuild.build({
    ...common,
    entryPoints: ['extension/sw.js'],
    outfile: join(EXT_DIR, 'sw.js'),
    format: 'esm',
    define: { __CONTEXTFLOW_TOKEN__: JSON.stringify(token) },
    metafile: true,
  });

  await esbuild.build({
    ...common,
    entryPoints: ['src/ext/options.js'],
    outfile: join(EXT_DIR, 'options.js'),
    format: 'iife',
    define: { __CONTEXTFLOW_TOKEN__: '""' },
    banner: { js: markdownLicenseComment() },
  });

  const storeBuild = STORE;
  const manifest = {
    manifest_version: 3,
    name: 'ContextFlow',
    version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    description: '网页高亮批注与 Markdown 导出；连接自己的本地服务后使用 AI 解释、总结和笔记同步。',
    minimum_chrome_version: '111',
    permissions: ['storage', 'nativeMessaging'],
    host_permissions: ['http://127.0.0.1:7317/*'],
    background: { service_worker: 'sw.js', type: 'module' },
    options_ui: { page: 'options.html', open_in_tab: true },
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
    icons: { 48: 'toolbar-48.png', 128: 'toolbar-128.png' },
    content_scripts: [{
      matches: ['http://*/*', 'https://*/*'],
      // 不写 world → 默认 ISOLATED。已实测那里的 CSS.highlights 能正常绘制，
      // 所以整套 UI 都留在 ISOLATED，页面 JS 碰不到我们的任何东西。
      js: ['app.js'],
      run_at: 'document_idle',
      all_frames: false,
    }],
  };
  // Chrome Web Store 自己签名并分配 id，不需要 manifest.key。开发者模式需要稳定 id
  // 才能配置 allowedOrigins，所以普通 build 保留 key；--store 构建删除它。
  if (!storeBuild) manifest.key = key;
  writeFileSync(join(EXT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const f of ['toolbar-16.png', 'toolbar-32.png',
    'toolbar-48.png', 'toolbar-128.png']) {
    if (existsSync(`assets/${f}`)) copyFileSync(`assets/${f}`, join(EXT_DIR, f));
    else console.warn(`  ⚠ 缺 assets/${f} —— 先跑 node tools/gen-assets.mjs --png`);
  }
  for (const file of ['options.html', 'options.css']) {
    copyFileSync(`extension/${file}`, join(EXT_DIR, file));
  }
  // The hosted policy uses assets/mark.svg; the extension ships toolbar icons.
  writeFileSync(join(EXT_DIR, 'privacy.html'), readFileSync('store/privacy.html','utf8').replace('href="assets/mark.svg"','href="toolbar-32.png"'));

  // charset does not escape regex literals or banner comments, so also check
  // actual bytes. Fail the build before handing an unloadable extension over.
  for (const file of ['app.js','sw.js','options.js','manifest.json','options.html','options.css','privacy.html']) {
    assertExtensionText(readFileSync(join(EXT_DIR, file)), file);
  }

  const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
  const outputBytes = (result) => Object.values(result.metafile.outputs)[0]?.bytes || 0;
  console.log(`${join(EXT_DIR, 'app.js')}  ${kb(outputBytes(ui))}`);
  console.log(`${join(EXT_DIR, 'sw.js')}   ${kb(outputBytes(sw))}`);
  if (storeBuild) {
    console.log('Chrome Web Store 包：manifest.key 已移除；商店会分配扩展 id');
  } else {
    console.log(`扩展 id  ${id}`);
    console.log('加载扩展后，基础批注即可用；开启 AI / 同步请在「扩展程序选项」按官网下载桌面端、打开并确认连接。');
    console.log(`高级 CLI 兼容：已有服务可在项目目录执行 npm run pair -- ${id}，再在扩展连接页的「高级与兼容方式」填写配对码；无需改 allowedOrigins。`);
  }
}

async function buildUserscript() {
const outDir = PUBLIC_SKILL ? (process.env.CONTEXTFLOW_PUBLIC_DIR || 'release/public-skill') : 'dist';
const outfile = join(outDir, 'skill.js');
mkdirSync(outDir, { recursive: true });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const config = {
  entryPoints: ['src/skill/entry.js'],
  outfile,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  charset: 'utf8',
  legalComments: 'none',
  // 公开userscript绝不带发布者本机 token。它可以离线标注/导出；连接本地服务需后续配对。
  define: { __CONTEXTFLOW_TOKEN__: JSON.stringify(PUBLIC_SKILL ? '' : token) },
  banner: {
    js: (PUBLIC_SKILL
      ? `// ContextFlow 浏览器 Skill v${version} — LLMBridge AI + 本地批注 + Obsidian/Markdown 同步。`
      : `// ContextFlow v${version} — 私人本地服务版，请勿公开发布。`) + `\n${markdownLicenseComment()}`,
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log('watching src/ … (Ctrl-C 退出)');
} else {
  const publicPlugin = {
    name: 'contextflow-public-llmbridge',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/core\/api\.js$/ }, () =>
        ({ path: join(process.cwd(), 'src/public/api.js') }));
      build.onResolve({ filter: /^\.\/settings\.js$/ }, (args) => args.importer.endsWith('/src/skill/panel.js')
        ? ({ path: join(process.cwd(), 'src/public/settings.js') }) : null);
    },
  };
  const r = await esbuild.build({ ...config, metafile: true,
    plugins: PUBLIC_SKILL ? [publicPlugin] : [] });
  const out = Object.values(r.metafile.outputs)[0];
  if (PUBLIC_SKILL) {
    const skill = readFileSync(outfile);
    const sha256 = createHash('sha256').update(skill).digest('hex');
    let sourceCommit = process.env.CONTEXTFLOW_SOURCE_COMMIT || '';
    if (!sourceCommit) {
      try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
      catch { sourceCommit = 'unknown'; }
    }
    const manifest = {
      schemaVersion: 1, name: 'contextflow-browser-skill', version, sourceCommit,
      sourceDateEpoch: process.env.SOURCE_DATE_EPOCH || null,
      artifact: { path: 'skill.js', bytes: skill.length, sha256 },
      requirements: { chromium: '>=110', browserHost: 'LLMBridge + File System Access API' },
      limits: { indexedDbSchema: 4, articleChars: 400000, bridgeTimeoutMs: 60000, imageBytes: 8388608 },
      capabilities: ['llmbridge-ai', 'anchors', 'annotations', 'pasted-image-attachments', 'indexeddb', 'markdown-copy-download', 'obsidian-markdown-folder-sync'],
      excluded: ['mcp', 'siyuan', 'local-service', 'local-agent', 'api-key'],
    };
    const readme = readFileSync('PUBLIC_README.md', 'utf8').replace(/^\*\*版本：.*$/m, `**版本：${version}**`);
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(outDir, 'README.md'), readme.endsWith('\n') ? readme : `${readme}\n`);
    const sums = [
      `${sha256}  skill.js`,
      `${createHash('sha256').update(readFileSync(join(outDir, 'manifest.json'))).digest('hex')}  manifest.json`,
      `${createHash('sha256').update(readFileSync(join(outDir, 'README.md'))).digest('hex')}  README.md`,
    ].join('\n') + '\n';
    writeFileSync(join(outDir, 'SHA256SUMS'), sums);
  }
  console.log(`${outfile}  ${(out.bytes / 1024).toFixed(1)} KB${PUBLIC_SKILL ? ' · 无本机 token' : ''}`);
}
}
