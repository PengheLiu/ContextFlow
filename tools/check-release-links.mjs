import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkReleaseLinks(version, fetcher = fetch) {
  const base = `https://github.com/PengheLiu/ContextFlow/releases/download/v${version}/contextflow-companion-${version}.zip`;
  const urls = [base, `${base}.sha256`, 'https://pengheliu.github.io/ContextFlow/privacy.html'];
  for (const url of urls) {
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`公开下载检查失败（${response.status}）：${url}。先发布匹配版本的 companion 包，再提交 Chrome 商店更新。`);
  }
  return urls;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  try { for (const url of await checkReleaseLinks(version)) console.log(`可用：${url}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
