// 源码卫生检查。
//
// 起因：本仓库已经两次把**字面控制字符**写进源文件（一次是 lookupkey.js 里
// 当分隔符用的 NUL，一次是 layout.mjs 的正则字符类）。危害是隐性的：
//   · git 见到 NUL 就把整个文件当二进制 —— diff 没了，review 看不见改动
//   · 编辑器不显示，复制粘贴会静默丢失，代码看起来完全正常
//   · 功能是对的，所以**所有测试都通过**，没有任何信号
// 该写的是转义序列（'\u001f'），运行时值一样，源码保持纯文本。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', 'dist', 'assets']);
// 制表符与换行是正常的；其余 C0 控制字符不该出现在源码里
const CTRL = /[\u0000-\u0008\u000b-\u001f]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.mjs', '.json', '.md', '.html', '.css'].includes(extname(p))) out.push(p);
  }
  return out;
}

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('源码卫生\n');

const files = walk(ROOT);

t(`扫描到 ${files.length} 个源文件（目录遍历本身没瞎跑）`, () =>
  assert.ok(files.length > 10, `只找到 ${files.length} 个，遍历可能有问题`));

t('没有字面控制字符（应写成 \\uXXXX 转义）', () => {
  const bad = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!CTRL.test(text)) continue;
    const line = text.split('\n').findIndex((l) => CTRL.test(l)) + 1;
    const ch = text.match(CTRL)[0].charCodeAt(0);
    bad.push(`${f.replace(ROOT, '')}:${line} 含 0x${ch.toString(16).padStart(2, '0')}`);
  }
  assert.deepEqual(bad, [], `\n       ${bad.join('\n       ')}`);
});

t('没有 NUL 字节（会让 git 把源文件判成二进制）', () => {
  const bad = files.filter((f) => readFileSync(f).includes(0));
  assert.deepEqual(bad.map((f) => f.replace(ROOT, '')), []);
});

console.log(`\n${pass} 项通过`);
