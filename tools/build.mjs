// 一份源码 → 两个产物。当前实现 userscript 产物（单文件 IIFE，可直接粘贴）。
// 扩展产物在 M2 接入时加 entryPoints 即可，核心模块无需改动。
import esbuild from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

mkdirSync('dist', { recursive: true });

// 从本地配置读出 token 编译进产物，省去手抄。
// 当 allowAnyOrigin 打开时，X-ContextFlow 的强制预检不再拦任何 origin，
// token 就成了唯一防线 —— 因此这一步不是便利，而是必需。
let token = '';
try {
  token = JSON.parse(readFileSync(join(homedir(), '.contextflow', 'config.json'), 'utf8')).token || '';
} catch { /* 未初始化过服务：留空，服务端 requireToken=false 时不校验 */ }

const config = {
  entryPoints: ['src/skill/main.js'],
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
