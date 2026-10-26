import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ServiceManager } from '../desktop/service.mjs';
import { terminateTree } from '../server/platform.mjs';
import { assertDesktopArchiveFiles } from './desktop-package-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultTarget = process.platform === 'win32' ? 'release/.desktop-build.noindex/win-unpacked'
  : `release/.desktop-build.noindex/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/ContextFlow.app`;
const target = resolve(process.argv[2] || join(root, defaultTarget));
const mac = target.endsWith('.app'), resources = join(target, mac ? 'Contents/Resources' : 'resources');
const metadata = JSON.parse(readFileSync(join(resources, 'desktop-build.json'), 'utf8'));
const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const asar = require('@electron/asar');
assertDesktopArchiveFiles(asar.listPackage(join(resources, 'app.asar')));
const runtime = join(resources, 'runtime', metadata.platform === 'win32' ? 'node.exe' : 'node');
assert.ok(existsSync(join(resources, 'core/src/core/data-owner.mjs')), 'Missing shipped data-directory ownership protocol');
for (const file of [runtime, join(resources, 'runtime/NODE-LICENSE'), join(resources, 'core/server/platform.mjs'), join(resources, 'core/server/secrets.mjs'), join(resources, 'core/server/sync-status.mjs'), join(resources, 'core/server/reading-status.mjs'), join(resources, 'core/src/core/destination.js')]) assert.ok(existsSync(file), `Missing ${file}`);
for (const name of ['@anthropic-ai/sdk', 'ws']) assert.ok(existsSync(join(resources, 'core/node_modules', name, 'package.json')), `Missing shipped production dependency: ${name}`);
assert.ok(!existsSync(join(resources, 'core/config.json')), 'Never ship maintainer configuration');
assert.ok(!existsSync(join(resources, 'core/extension-pairings.json')), 'Never ship browser credentials');
const menuBar = join(resources, 'native', 'menu-bar');
assert.match(metadata.sources?.['desktop/native/menu-bar.m'] || '', /^[a-f0-9]{64}$/, 'Native helper source must be bound to build metadata');
if (metadata.platform === 'darwin') {
  if (process.platform === 'darwin') {
    // Integrity only: an ad-hoc signature must also pass. This does not imply
    // an Apple-trusted publisher or Gatekeeper / notarization acceptance.
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', target], { timeout: 30000, stdio: 'pipe' });
    const minimum = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print LSMinimumSystemVersion', join(target, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.equal(minimum, '13.5', 'The application minimum must match the bundled Node 24 runtime');
  }
  assert.ok(existsSync(menuBar), 'Missing native menu-bar geometry helper');
  assert.ok(statSync(menuBar).mode & 0o111, 'Native geometry helper must remain executable');
  if (process.platform === 'darwin') {
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', menuBar], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/);
    assert.ok(architectures.includes(metadata.arch === 'x64' ? 'x86_64' : 'arm64'), 'Native helper architecture must match the packaged application');
    if (metadata.channel === 'release') execFileSync('/usr/bin/codesign', ['--verify', '--strict', menuBar], { timeout: 5000, stdio: 'pipe' });
  }
} else assert.ok(!existsSync(menuBar), 'Windows packages must not ship the macOS geometry executable');
if (metadata.platform === process.platform && metadata.arch === process.arch) {
  if (metadata.platform === 'darwin') {
    const geometry = JSON.parse(execFileSync(menuBar, [], { encoding: 'utf8', timeout: 5000 }));
    assert.deepEqual(Object.keys(geometry), ['screens']); assert.ok(Array.isArray(geometry.screens) && geometry.screens.length > 0);
    for (const screen of geometry.screens) {
      assert.deepEqual(Object.keys(screen).sort(), ['frame', 'left', 'right']);
      for (const [name, rect] of Object.entries(screen)) {
        if (rect === null && name !== 'frame') continue;
        assert.deepEqual(Object.keys(rect).sort(), ['height', 'width', 'x', 'y']);
        assert.ok(Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0, 'Native geometry must contain finite positive rectangles');
      }
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), 'cf-shipped-runtime-')), data = join(temporary, 'data'); mkdirSync(data);
  // Never execute inside the checkout: Node can otherwise silently resolve a
  // missing packaged dependency from this repository's ancestor node_modules.
  const isolatedCore = join(temporary, 'core'), isolatedRuntime = join(temporary, process.platform === 'win32' ? 'node.exe' : 'node');
  cpSync(join(resources, 'core'), isolatedCore, { recursive: true }); cpSync(runtime, isolatedRuntime);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ port }));
  const service = new ServiceManager({ paths: { data, logs: join(temporary, 'logs') }, runtime: isolatedRuntime,
    core: isolatedCore, secretKey: randomBytes(32).toString('base64'), terminateTree,
    environment: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined, NODE_EXTRA_CA_CERTS: undefined } });
  try {
    await service.start(); assert.equal(service.state, 'running', service.message);
    assert.equal((await service.request('/health')).body.desktopManaged, true);
    assert.equal((await service.request('/config')).status, 200);
  } finally { await service.stop(); rmSync(temporary, { recursive: true, force: true }); }
  console.log(`Verified shipped ${metadata.platform}-${metadata.arch} runtime starts its packaged SQLite service without system Node.`);
} else console.log(`Verified ${metadata.platform}-${metadata.arch} package structure; runtime execution requires its target OS/architecture.`);
