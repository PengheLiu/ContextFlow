import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseCommand, renderPlist, runService, servicePaths } from '../tools/service.mjs';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); process.exitCode = 1; }
};
const temp = () => mkdtempSync(join(tmpdir(), 'cf-service-'));
const fakeResult = (status = 0, stdout = '', stderr = '') => ({ status, stdout, stderr });

console.log('launchd 服务命令\n');

await t('无参数默认安装，支持管理子命令', () => {
  assert.deepEqual(parseCommand([]), { command: 'install', follow: false });
  assert.deepEqual(parseCommand(['logs', '--follow']), { command: 'logs', follow: true });
  assert.equal(parseCommand(['wat']).command, 'invalid');
  assert.equal(parseCommand(['restart', '--follow']).command, 'invalid');
});

await t('plist 使用绝对路径并转义 XML', () => {
  const p = servicePaths({ home: '/Users/a&b', root: '/code/<cf>', node: '/node/bin', uid: 7 });
  const text = renderPlist(p);
  assert.match(text, /com\.contextflow\.server/);
  assert.match(text, /\/node\/bin/);
  assert.match(text, /\/code\/&lt;cf&gt;\/server\/index\.mjs/);
  assert.match(text, /\/Users\/a&amp;b/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
});

await t('install 写入 plist 并按顺序重载服务', async () => {
  const home = temp();
  const root = join(home, 'repo');
  const node = join(home, 'node');
  mkdirSync(join(root, 'server'), { recursive: true });
  writeFileSync(node, '');
  writeFileSync(join(root, 'server', 'index.mjs'), '');
  const paths = servicePaths({ home, root, node, uid: 42 });
  const calls = [], output = [];
  const code = await runService('install', {
    platform: 'darwin', paths, out: (s) => output.push(s), err: (s) => output.push(s),
    runner: (_cmd, args) => { calls.push(args); return fakeResult(); },
    fetcher: async (_url, opts) => { assert.equal(opts.headers['X-ContextFlow'], '1'); return { ok: true }; },
    attempts: 1,
  });
  assert.equal(code, 0);
  assert.ok(existsSync(paths.plist));
  assert.deepEqual(calls, [
    ['bootout', paths.target],
    ['bootstrap', paths.domain, paths.plist],
    ['kickstart', '-k', paths.target],
  ]);
  assert.match(readFileSync(paths.plist, 'utf8'), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  rmSync(home, { recursive: true, force: true });
});

await t('status 区分未安装、未加载与健康状态', async () => {
  const home = temp();
  const paths = servicePaths({ home, root: home, node: process.execPath, uid: 9 });
  let errors = [];
  assert.equal(await runService('status', { platform: 'darwin', paths, err: (s) => errors.push(s) }), 1);
  mkdirSync(paths.launchAgents, { recursive: true });
  writeFileSync(paths.plist, 'x');
  assert.equal(await runService('status', {
    platform: 'darwin', paths, err: () => {}, runner: () => fakeResult(1),
  }), 2);
  assert.equal(await runService('status', {
    platform: 'darwin', paths, out: () => {}, runner: () => fakeResult(0, 'pid = 123'),
    fetcher: async () => ({ ok: true }),
  }), 0);
  rmSync(home, { recursive: true, force: true });
});

await t('uninstall 只删除 plist，保留数据', async () => {
  const home = temp();
  const paths = servicePaths({ home, root: home, node: process.execPath, uid: 8 });
  mkdirSync(paths.launchAgents, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  writeFileSync(paths.plist, 'x');
  writeFileSync(join(paths.dataDir, 'config.json'), '{}');
  const calls = [];
  assert.equal(await runService('uninstall', {
    platform: 'darwin', paths, out: () => {}, runner: (_c, a) => { calls.push(a); return fakeResult(); },
  }), 0);
  assert.ok(!existsSync(paths.plist));
  assert.ok(existsSync(join(paths.dataDir, 'config.json')));
  assert.deepEqual(calls, [['bootout', paths.target]]);
  rmSync(home, { recursive: true, force: true });
});

await t('非 macOS 明确拒绝', async () => {
  await assert.rejects(() => runService('install', { platform: 'linux' }), /仅支持 macOS/);
});

await t('服务收到 SIGTERM 后正常退出', async () => {
  const home = temp();
  const port = 18000 + Math.floor(Math.random() * 10000);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    port, translate: {}, explain: {}, agent: {}, sync: { backend: 'markdown' },
    markdown: { dir: join(home, 'notes'), folder: '/reading' },
    obsidian: {}, siyuan: {}, allowedOrigins: [], allowAnyOrigin: false, requireToken: false,
  }));
  const child = spawn(process.execPath, [resolve('server/index.mjs')], {
    cwd: resolve('.'), env: { ...process.env, CONTEXTFLOW_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolveReady, reject) => {
    const deadline = setTimeout(() => reject(new Error(`服务未启动：${output}`)), 5000);
    const check = () => {
      if (output.includes('ContextFlow 服务')) { clearTimeout(deadline); resolveReady(); }
      else setTimeout(check, 20);
    };
    check();
  });
  child.kill('SIGTERM');
  const code = await new Promise((resolveExit, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SIGTERM 后未退出')); }, 3000);
    child.on('exit', (value) => { clearTimeout(deadline); resolveExit(value); });
  });
  assert.equal(code, 0);
  assert.match(output, /收到 SIGTERM/);
  rmSync(home, { recursive: true, force: true });
});

console.log(`\n${pass} 项通过`);
