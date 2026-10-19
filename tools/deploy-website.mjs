import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { websiteFiles } from './build-website.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'PengheLiu/ContextFlow';
const api = (route, body, method) => JSON.parse(execFileSync('gh', [
  'api', `repos/${repository}/${route}`,
  ...(method ? ['-X', method] : []),
  ...(body ? ['--input', '-'] : []),
], { encoding: 'utf8', ...(body ? { input: JSON.stringify(body) } : {}) }));

// 默认只展示发布范围；明确 --publish 后才写入已启用的 Pages 分支。
if (!process.argv.includes('--publish')) {
  console.log(`官网：https://pengheliu.github.io/ContextFlow/\n目标：${repository} / gh-pages\n发布白名单：\n${websiteFiles.map(([, target]) => `  ${target}`).join('\n')}\n检查后运行 npm run deploy:website -- --publish；不会覆盖 Release 附件。`);
} else {
  const pages = api('pages');
  if (pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/') throw new Error('Pages 来源与预期不同，请先核对部署配置。');
  const base = api('git/ref/heads/gh-pages').object.sha;
  const parent = api(`git/commits/${base}`);
  const tree = [];
  for (const [source, path] of websiteFiles) {
    const bytes = readFileSync(join(root, source));
    const blob = api('git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const staged = api('git/trees', { base_tree: parent.tree.sha, tree });
  if (staged.sha === parent.tree.sha) {
    console.log(`官网文件未变化，无需重复提交：${base}`);
  } else {
    const commit = api('git/commits', { message: 'docs: publish ContextFlow product website', tree: staged.sha, parents: [base] });
    // 非强制快进；有人同时更新分支时拒绝覆盖，保留其更改。
    api('git/refs/heads/gh-pages', { sha: commit.sha, force: false }, 'PATCH');
    console.log(`已更新 gh-pages：${commit.sha}\n请确认 Pages 构建完成与公开 URL，再报告已上线。`);
  }
}
