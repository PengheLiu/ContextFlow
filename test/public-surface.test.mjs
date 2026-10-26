import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReleaseLinks, checkWebsiteLinks, checkDesktopDownloadLinks, releaseLinkOptions } from '../tools/check-release-links.mjs';

test('public surface checks include the desktop download landing page, not just the old privacy URL', async () => {
  const seen = [];
  const urls = await checkWebsiteLinks(async (url, options) => { seen.push(url); assert.equal(options.method, 'HEAD'); return { ok: true }; });
  assert.equal(urls.length, 4);
  assert.ok(seen.includes('https://pengheliu.github.io/ContextFlow/download.html'));
  await assert.rejects(checkWebsiteLinks(async url => ({ ok: !url.endsWith('/download.html'), status: 404 })), /请先部署完整官网/);
});

const desktop = (version = '1.1.0') => {
  const row = { status: 'available-unsigned', version, releaseTag: `v${version}`, artifact: `ContextFlow-${version}-mac-arm64.dmg`, sha256: 'a'.repeat(64) };
  row.downloadUrl = `https://github.com/PengheLiu/ContextFlow/releases/download/${row.releaseTag}/${row.artifact}`;
  row.checksumUrl = `${row.downloadUrl}.sha256`;
  return { desktop: { platforms: { 'darwin-arm64': row, 'win32-x64': { status: 'unpublished' } } } };
};
test('available desktop downloads require actual installer and exact public checksum; unpublished targets are skipped', async () => {
  const state = desktop(), row = state.desktop.platforms['darwin-arm64'], seen = [];
  const urls = await checkDesktopDownloadLinks(state, async (url, options) => {
    seen.push([url, options.method || 'GET']);
    return { ok: true, text: async () => `${row.sha256}  ${row.artifact}\n` };
  });
  assert.deepEqual(urls, [row.downloadUrl, row.checksumUrl]);
  assert.equal(seen.length, 3);
  await assert.rejects(checkDesktopDownloadLinks(state, async () => ({ ok: false, status: 404 })), /公开下载不可用/);
  await assert.rejects(checkDesktopDownloadLinks(state, async () => ({ ok: true, text: async () => 'wrong checksum' })), /摘要不一致/);
  assert.deepEqual(await checkDesktopDownloadLinks({ desktop: { platforms: { mac: { status: 'unpublished' } } } }, () => { throw new Error('must not fetch'); }), []);
});
test('reviewed 1.1.1 desktop download is checked without allowing arbitrary future versions or architectures', async () => {
  const state = desktop('1.1.1'), row = state.desktop.platforms['darwin-arm64'];
  const urls = await checkDesktopDownloadLinks(state, async () => ({ ok: true, text: async () => `${row.sha256}  ${row.artifact}\n` }));
  assert.deepEqual(urls, [row.downloadUrl, row.checksumUrl]);
  await assert.rejects(checkDesktopDownloadLinks(desktop('1.1.2'), () => { throw new Error('must not fetch'); }), /下载状态或资源地址无效/);
  const other = { desktop: { platforms: { 'darwin-x64': { ...row } } } };
  await assert.rejects(checkDesktopDownloadLinks(other, () => { throw new Error('must not fetch'); }), /下载状态或资源地址无效/);
});
test('desktop public checks reject arbitrary upstream URLs before making a request', async () => {
  const state = desktop(); state.desktop.platforms['darwin-arm64'].checksumUrl = 'https://invalid.test/private';
  await assert.rejects(checkDesktopDownloadLinks(state, () => { throw new Error('must not fetch'); }), /下载状态或资源地址无效/);
  for (const mutate of [row => row.releaseTag = 'v1.1.0-other', row => row.releaseTag = 'v1.2.0',
    row => row.version = '1.2.0', row => row.artifact = 'ContextFlow-1.2.0-mac-arm64.dmg']) {
    const invalid = desktop(), row = invalid.desktop.platforms['darwin-arm64']; mutate(row);
    row.downloadUrl = `https://github.com/PengheLiu/ContextFlow/releases/download/${row.releaseTag}/${row.artifact}`;
    row.checksumUrl = `${row.downloadUrl}.sha256`;
    await assert.rejects(checkDesktopDownloadLinks(invalid, () => { throw new Error('must not fetch'); }), /下载状态或资源地址无效/);
  }
});
test('published and candidate link checks cannot silently check the wrong version', async () => {
  const state = { candidateVersion: '1.1.0', publishedVersion: '1.0.0' };
  assert.deepEqual(releaseLinkOptions([], state), { version: '1.1.0', website: false });
  assert.deepEqual(releaseLinkOptions(['--published', '--website'], state), { version: '1.0.0', website: true });
  for (const args of [['--version', '1.0.0'], ['--published', '--published'], ['--publish']]) assert.throws(() => releaseLinkOptions(args, state));
  await assert.rejects(checkReleaseLinks('../unsafe'), /x.y.z/);
});
