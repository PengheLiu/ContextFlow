import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDshInstallation } from '../server/dsh-installation.mjs';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (error) { console.error(`  FAIL ${name}\n       ${error.stack}`); process.exitCode = 1; }
};
const systemEntry = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const userEntry = '/Users/fixture/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const cli = '/opt/homebrew/bin/dsh';
const resolve = (files, options = {}) => resolveDshInstallation({
  env: { HOME: '/Users/fixture', PATH: '/opt/homebrew/bin:/usr/bin' }, platform: 'darwin',
  isExecutable: path => files.includes(path), ...options,
});

console.log('DSH 桌面安装发现\n');
t('同时安装时优先使用桌面版内置入口', () => {
  const result = resolve([cli, systemEntry, userEntry]);
  assert.equal(result.bin, systemEntry);
  assert.equal(result.source, 'desktop');
  assert.equal(result.sourceLabel, '桌面版');
  assert.equal(result.available, true);
  assert.equal(result.appPath, '/Applications/DeepSeek Harness.app');
});
t('发现用户 Applications 目录中的桌面版', () => {
  const result = resolve([cli, userEntry]);
  assert.equal(result.bin, userEntry);
  assert.equal(result.source, 'desktop');
});
t('仅有 app 目录而没有可执行入口时回退到 PATH', () => {
  const result = resolve(['/Applications/DeepSeek Harness.app', cli]);
  assert.equal(result.bin, cli);
  assert.equal(result.source, 'cli');
  assert.equal(result.sourceLabel, '命令行兼容版');
});
t('显式 bin 和环境覆盖优先于桌面安装，bin 优先于环境覆盖', () => {
  const env = { HOME: '/Users/fixture', PATH: '/fixture:/opt/homebrew/bin', CONTEXTFLOW_DSH_BIN: '/fixture/env-dsh' };
  const files = [systemEntry, cli, '/fixture/env-dsh', '/fixture/option-dsh'];
  assert.equal(resolve(files, { env }).bin, '/fixture/env-dsh');
  assert.equal(resolve(files, { env }).source, 'explicit');
  assert.equal(resolve(files, { env, bin: '/fixture/option-dsh' }).bin, '/fixture/option-dsh');
  assert.equal(resolve(files, { bin: systemEntry }).source, 'desktop');
});
t('显式命令通过 PATH 解析，缺失入口不偷偷改用桌面版', () => {
  assert.equal(resolve([systemEntry, cli], { bin: 'dsh' }).bin, cli);
  const result = resolve([systemEntry, cli], { bin: '/missing/dsh' });
  assert.equal(result.bin, '/missing/dsh');
  assert.equal(result.available, false);
  assert.equal(result.source, 'explicit');
});
t('未安装时明确报告不可用，其他平台沿用 PATH', () => {
  assert.deepEqual(resolve([]), { bin: 'dsh', source: 'cli', sourceLabel: '命令行兼容版', available: false });
  assert.equal(resolve([systemEntry, cli], { platform: 'linux' }).bin, cli);
  assert.equal(resolveDshInstallation({ platform: 'win32', env: { PATH: 'C:\\Apps;C:\\Windows', PATHEXT: '.EXE;.CMD' },
    isExecutable: path => path === 'C:\\Apps\\dsh.EXE' }).bin, 'C:\\Apps\\dsh.EXE');
});
t('可执行文件检查与桌面 CLI 软链接在真实文件系统上成立', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-dsh-discovery-'));
  try {
    const appRoot = join(root, 'Applications');
    const entry = join(appRoot, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '#!/bin/sh\nexit 0\n');
    const options = { env: { HOME: root, PATH: root }, appRoots: [appRoot], platform: 'darwin' };
    assert.equal(resolveDshInstallation(options).available, false, 'non-executable file is not an installation');
    chmodSync(entry, 0o755);
    assert.equal(resolveDshInstallation(options).bin, entry);
    symlinkSync(entry, join(root, 'dsh'));
    const linked = resolveDshInstallation({ ...options, bin: 'dsh' });
    assert.equal(linked.source, 'desktop');
    assert.equal(linked.appPath, realpathSync(join(appRoot, 'DeepSeek Harness.app')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
console.log(`\n${pass} 项 DSH 安装发现测试通过`);
