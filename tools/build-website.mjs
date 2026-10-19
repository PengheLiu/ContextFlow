import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// 官网发布白名单；不部署整个仓库，也不复制 release 内的旧包或个人配置。
export const websiteFiles = [
  ['store/index.html', 'index.html'],
  ['store/site.css', 'site.css'],
  ['store/privacy.html', 'privacy.html'],
  ['store/demo.html', 'demo.html'],
  ['assets/mark.svg', 'assets/mark.svg'],
  ['assets/readme/inline-annotation.png', 'assets/inline-annotation.png'],
];

export function stageWebsite(destination) {
  const output = resolve(destination);
  for (const [source, target] of websiteFiles) {
    const input = join(root, source);
    if (!lstatSync(input).isFile()) throw new Error(`官网源文件必须为普通文件：${source}`);
    const file = join(output, target);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(input, file);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`官网静态目录：${stageWebsite(join(root, 'release/website'))}`);
}
