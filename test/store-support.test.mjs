import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { packageStoreSupport } from '../tools/package-store-support.mjs';

const directory = mkdtempSync(join(tmpdir(), 'contextflow-support-test-'));
let server;
let logs = '';
try {
  const artifacts = packageStoreSupport(directory);
  assert.equal(artifacts.length, 2);
  for (const artifact of artifacts) {
    const digest = createHash('sha256').update(readFileSync(artifact.path)).digest('hex');
    assert.equal(digest, artifact.sha256);
    assert.ok(readFileSync(`${artifact.path}.sha256`, 'utf8').startsWith(digest));
    const files = execFileSync('unzip', ['-Z1', artifact.path], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(files.every(file => !/(^|\/)(\.env|\.git|node_modules|config\.json|extension-pairings\.json|dist)(\/|$)/.test(file)));
  }

  const site = join(directory, 'site');
  execFileSync('unzip', ['-q', artifacts[1].path, '-d', site]);
  assert.deepEqual(readdirSync(site).sort(), ['demo.html', 'index.html', 'privacy.html']);
  for (const filename of readdirSync(site)) {
    const html = readFileSync(join(site, filename), 'utf8');
    assert.doesNotMatch(html, /\/Users\/|cf-test-token-|__CONTEXTFLOW_TOKEN__/);
    const document = new JSDOM(html).window.document;
    assert.ok(document.title);
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.equal(document.querySelectorAll('script,iframe,form').length, 0);
    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (!href.startsWith('https://')) assert.ok(existsSync(join(site, href)), `站内链接不可用：${href}`);
    }
  }

  const companion = join(directory, 'companion');
  execFileSync('unzip', ['-q', artifacts[0].path, '-d', companion]);
  const manifest = JSON.parse(readFileSync(join(companion, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(companion, 'package-lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.scripts).sort(), ['pair', 'server', 'service']);
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], {
    cwd: companion, stdio: 'pipe', timeout: 120000,
  });
  assert.ok(existsSync(join(companion, 'node_modules/@anthropic-ai/sdk/package.json')));
  assert.equal(existsSync(join(companion, 'node_modules/esbuild')), false);

  const config = join(directory, 'config');
  mkdirSync(config);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  writeFileSync(join(config, 'config.json'), JSON.stringify({ port, requireToken: true, token: 'support-test-legacy' }));
  const env = { ...process.env, CONTEXTFLOW_DIR: config };
  const extensionId = 'c'.repeat(32);
  const pairingOutput = execFileSync(process.execPath, ['tools/pair-extension.mjs', extensionId], { cwd: companion, env, encoding: 'utf8' });
  const token = pairingOutput.match(/^[A-Za-z0-9_-]{43}$/m)?.[0];
  assert.ok(token, '发行包中的配对命令未能生成凭证');
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: companion, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = chunk => { logs = (logs + chunk).slice(-8000); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  const endpoint = `http://127.0.0.1:${port}/health`;
  const headers = { 'X-ContextFlow': '1', 'X-ContextFlow-Extension': extensionId, Authorization: `Bearer ${token}` };
  let response;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`发行包服务退出：${logs}`);
    try {
      response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(500) });
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.ok(response, `发行包服务启动失败：${logs}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).extensionPaired, true);
  const unauthorized = await fetch(endpoint, { headers: { ...headers, Authorization: 'Bearer wrong' } });
  assert.equal(unauthorized.status, 401);
  execFileSync(process.execPath, ['tools/pair-extension.mjs', '--revoke', extensionId], { cwd: companion, env, stdio: 'pipe' });
  const revoked = await fetch(endpoint, { headers });
  assert.equal(revoked.status, 401);
  console.log('发布准备包：静态站点、文件隔离、校验和、全新生产依赖安装、服务配对及撤销验证通过');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  rmSync(directory, { recursive: true, force: true });
}
