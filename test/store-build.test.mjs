import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = mkdtempSync(join(tmpdir(), 'contextflow-store-test-'));
const output = join(directory, 'extension');
const sentinel = 'cf-test-token-publisher-secret-must-never-ship';
try {
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ token: sentinel }));
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], {
    env: { ...process.env, CONTEXTFLOW_DIR: directory, CONTEXTFLOW_EXT_DIR: output }, stdio: 'pipe',
  });
  const files = readdirSync(output);
  for (const file of files) assert.ok(!readFileSync(join(output, file)).includes(sentinel), `${file} 泄露发布者 token`);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.key, undefined);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:7317/*']);
  assert.equal(manifest.options_ui.page, 'options.html');
  for (const file of ['options.html', 'options.js', 'options.css', 'privacy.html']) assert.ok(files.includes(file));
  const icon = readFileSync(join(output, manifest.icons[128]));
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);
  const app = readFileSync(join(output, 'app.js'), 'utf8');
  assert.ok(app.indexOf('setBrowserStorage({') < app.indexOf('migrateLegacyKeys()'));
  assert.ok(app.includes('cf-offline'));
  assert.ok(app.includes('initializePrivateStorage().then'));
  const worker = readFileSync(join(output, 'sw.js'), 'utf8');
  assert.ok(worker.includes('TRUSTED_CONTEXTS'));
  assert.ok(worker.includes('PAIRING_REQUIRED'));
  console.log('商店构建：凭证隔离、manifest、设置页、图标及私有存储初始化顺序通过');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
