import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceReleaseState } from './check-product-release.mjs';
import { validateUpdateFeed, UPDATE_DOWNLOAD_URL, UPDATE_STORE_URL } from '../src/core/updates.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export function publishedUpdateFeed(state = sourceReleaseState()) {
  const row = (version, url) => ({ version, url, releaseNotesUrl: `https://github.com/PengheLiu/ContextFlow/releases/tag/v${version}` });
  const desktop = {};
  for (const [target, release] of Object.entries(state.desktop.platforms)) {
    if (['published', 'available-unsigned'].includes(release.status)) desktop[target] = row(release.version, UPDATE_DOWNLOAD_URL);
  }
  return validateUpdateFeed({ schemaVersion: 1, extension: row(state.publishedExtension.version, UPDATE_STORE_URL), desktop });
}
export function checkUpdateFeed(repository = root) {
  const expected = publishedUpdateFeed(sourceReleaseState(repository));
  const actual = JSON.parse(readFileSync(join(repository, 'store/updates.json'), 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('官网更新清单与已发布状态不一致。请核对公开版本后运行 npm run updates:sync；不要将候选版本冒充已发布版本。');
  return expected;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) writeFileSync(join(root, 'store/updates.json'), JSON.stringify(publishedUpdateFeed(), null, 2) + '\n');
  else checkUpdateFeed();
  console.log('更新清单与各渠道已发布状态一致');
}
