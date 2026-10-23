import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkReleaseLinks(version, fetcher = fetch) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('发行版本必须为 x.y.z。');
  const base = `https://github.com/PengheLiu/ContextFlow/releases/download/v${version}/contextflow-companion-${version}.zip`;
  const urls = [base, `${base}.sha256`, 'https://pengheliu.github.io/ContextFlow/privacy.html'];
  for (const url of urls) {
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`公开下载检查失败（${response.status}）：${url}。先发布匹配版本的 companion 包，再提交 Chrome 商店更新。`);
  }
  return urls;
}

export async function checkWebsiteLinks(fetcher = fetch) {
  const urls = ['', 'download.html', 'privacy.html', 'demo.html'].map(path => `https://pengheliu.github.io/ContextFlow/${path}`);
  for (const url of urls) {
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`官网公开入口不可用（${response.status}）：${url}。请先部署完整官网，再推广对应安装流程。`);
  }
  return urls;
}

export async function checkDesktopDownloadLinks(state, fetcher = fetch) {
  const urls = [];
  for (const [target, row] of Object.entries(state.desktop?.platforms || {})) {
    if (row.status !== 'available-unsigned') continue;
    const base = 'https://github.com/PengheLiu/ContextFlow/releases/download/';
    if (target !== 'darwin-arm64' || row.version !== '1.1.0' || row.releaseTag !== `v${row.version}`
      || row.artifact !== `ContextFlow-${row.version}-mac-arm64.dmg`
      || !/^[a-f0-9]{64}$/.test(row.sha256 || '')
      || row.downloadUrl !== `${base}${row.releaseTag}/${row.artifact}`
      || row.checksumUrl !== `${row.downloadUrl}.sha256`) throw new Error('桌面下载状态或资源地址无效，拒绝访问不明确的下载目标。');
    for (const url of [row.downloadUrl, row.checksumUrl]) {
      const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`桌面公开下载不可用（${response.status}）：${url}`);
      urls.push(url);
    }
    const response = await fetcher(row.checksumUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok || Number(response.headers?.get?.('content-length')) > 4096) throw new Error('桌面公开校验文件不可用或过大。');
    const checksum = await response.text();
    if (checksum.length > 4096 || checksum.trim() !== `${row.sha256}  ${row.artifact}`) throw new Error('桌面公开校验文件与已记录的安装包摘要不一致。');
  }
  return urls;
}

export function releaseLinkOptions(args, { candidateVersion, publishedVersion }) {
  if (args.some(arg => !['--published', '--website'].includes(arg)) || new Set(args).size !== args.length) throw new Error('仅支持 --published 与 --website。默认检查候选版本，--published 检查已公开冻结版本。');
  return { version: args.includes('--published') ? publishedVersion : candidateVersion, website: args.includes('--website') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const status = JSON.parse(readFileSync(new URL('../product/release.json', import.meta.url), 'utf8'));
    const options = releaseLinkOptions(process.argv.slice(2), { candidateVersion: pkg.version, publishedVersion: status.publishedGithub.version });
    const urls = [...await checkReleaseLinks(options.version), ...(options.website ? [...await checkWebsiteLinks(), ...await checkDesktopDownloadLinks(status)] : [])];
    for (const url of new Set(urls)) console.log(`可用：${url}`);
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
