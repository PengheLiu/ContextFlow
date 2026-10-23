import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, cpSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { desktopBuildPaths, parseDesktopBuildArgs, stageDesktopArtifacts, packageDesktop } from '../tools/package-desktop.mjs';
import { assertDesktopArchiveFiles, REQUIRED_DESKTOP_ARCHIVE_FILES } from '../tools/desktop-package-files.mjs';

test('ASAR package validation accepts Windows and POSIX listings of the same real archive, retaining exact required files', async () => {
  const requireDesktop = createRequire(new URL('../desktop/package.json', import.meta.url)), asar = requireDesktop('@electron/asar');
  const temporary = mkdtempSync(join(tmpdir(), 'contextflow-asar-paths-'));
  try {
    const source = join(temporary, 'source'), archive = join(temporary, 'app.asar');
    for (const file of REQUIRED_DESKTOP_ARCHIVE_FILES) {
      const parts = file.split('/'); mkdirSync(join(source, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(source, ...parts), `packaged fixture: ${file}`);
    }
    await asar.createPackage(source, archive);
    assert.ok(asar.getRawHeader(archive).header.files['main.mjs'], 'Actual archive header must contain its entrypoint');
    assert.equal(asar.extractFile(archive, 'main.mjs').toString(), 'packaged fixture: main.mjs');
    assertDesktopArchiveFiles(asar.listPackage(archive));
    // This is the upstream listFiles traversal: its path.join is platform
    // dependent even though the actual ASAR header and payload are unchanged.
    const listWith = path => {
      const files = [];
      const visit = (base, node) => { for (const [child, metadata] of Object.entries(node.files || {})) {
        const full = path.join(base, child); files.push(full); visit(full, metadata);
      } };
      visit('/', asar.getRawHeader(archive).header); return files;
    };
    const windows = listWith(win32), unix = listWith(posix);
    assert.ok(windows.includes('\\main.mjs')); assert.ok(!windows.includes('/main.mjs'), 'Reproduce the old Windows false Missing main.mjs');
    assert.deepEqual([...assertDesktopArchiveFiles(windows)].sort(), [...assertDesktopArchiveFiles(unix)].sort());
    for (const file of REQUIRED_DESKTOP_ARCHIVE_FILES) {
      assert.throws(() => assertDesktopArchiveFiles(unix.filter(entry => entry !== `/${file}`)), new RegExp(`Missing ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.throws(() => assertDesktopArchiveFiles(windows.filter(entry => entry !== `\\${file.replace(/\//g, '\\')}`)), /Missing /);
    }
    for (const file of ['smoke.mjs', 'build-guard.cjs']) {
      assert.throws(() => assertDesktopArchiveFiles([...unix, `/${file}`]), /Unexpected /);
      assert.throws(() => assertDesktopArchiveFiles([...windows, `\\${file}`]), /Unexpected /);
    }
    for (const path of ['../main.mjs', '/ui/../main.mjs', '\\ui\\..\\main.mjs', 'C:\\main.mjs', '//main.mjs', '/ui//app.js']) {
      assert.throws(() => assertDesktopArchiveFiles([...unix, path]), /Invalid ASAR path/);
    }
    assert.throws(() => assertDesktopArchiveFiles([...unix, '\\main.mjs']), /Duplicate ASAR path/);
    assert.throws(() => assertDesktopArchiveFiles(unix.map(entry => entry === '/main.mjs' ? '/Main.mjs' : entry)), /Missing main.mjs/);
    const checker = readFileSync(new URL('../tools/check-desktop-package.mjs', import.meta.url), 'utf8');
    assert.match(checker, /assertDesktopArchiveFiles\(asar\.listPackage\(join\(resources, 'app\.asar'\)\)\)/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'contextflow-build-paths-'));
  const paths = desktopBuildPaths(root, 'product-preview');
  mkdirSync(paths.staging, { recursive: true });
  return { root, paths, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('Unpacked builds persist under noindex, not beside deliverable installers', async () => {
  const sample = fixture();
  try {
    let options;
    const result = await packageDesktop({ repository: sample.root, argv: ['--dir', '--mac', '--arm64'], build: async value => { options = value; return []; } });
    assert.equal(basename(result.staging), '.desktop-build.noindex');
    assert.equal(options.config.directories.output, result.staging);
    assert.equal(options.publish, 'never');
    assert.deepEqual(options.mac, []); assert.equal(options.arm64, true);
    assert.deepEqual(result.files, []);
    assert.equal(existsSync(result.artifacts), false, 'pack 不复制或暴露 .app');
    const config = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
    assert.equal(config.build.directories.output, '../release/.desktop-build.noindex');
    assert.equal(config.build.mac.minimumSystemVersion, '13.5', '整包最低系统不能低于内置 Node 24 的 13.5 前提');
    const installer = readFileSync(new URL('../desktop/installer.nsh', import.meta.url), 'utf8');
    assert.match(installer, /!macro customInit[\s\S]*AtLeastWin10[\s\S]*Abort[\s\S]*!macroend/);
    assert.match(config.scripts.dist, /package-desktop\.mjs/);
    assert.match(config.scripts.pack, /package-desktop\.mjs --dir/);
  } finally { sample.close(); }
});
test('Only this build installers and matching metadata are copied; apps and stale files stay in staging', () => {
  const sample = fixture();
  try {
    const name = 'ContextFlow-1.0.0-mac-arm64.dmg', file = join(sample.paths.staging, name);
    writeFileSync(file, 'installer bytes');
    writeFileSync(join(sample.paths.staging, 'ContextFlow-0.9.0-mac-arm64.dmg'), 'old installer');
    writeFileSync(join(sample.paths.staging, 'latest-mac.yml'), JSON.stringify({ path: name, files: [{ url: name }] }));
    writeFileSync(join(sample.paths.staging, 'latest.yml'), JSON.stringify({ path: 'ContextFlow-1.0.0-win-x64.exe' }));
    mkdirSync(join(sample.paths.staging, 'mac-arm64', 'ContextFlow.app'), { recursive: true });
    const output = stageDesktopArtifacts([file], { ...sample.paths, parseMetadata: JSON.parse });
    assert.deepEqual(output.map(file => basename(file)), [name, `${name}.sha256`, 'latest-mac.yml']);
    assert.deepEqual(readdirSync(sample.paths.artifacts).sort(), [name, `${name}.sha256`, 'latest-mac.yml'].sort());
    assert.equal(readFileSync(output[0], 'utf8'), 'installer bytes');
    assert.ok(existsSync(join(sample.paths.staging, 'mac-arm64', 'ContextFlow.app')));
    assert.throws(() => stageDesktopArtifacts([], sample.paths), /没有生成可交付/);
    assert.throws(() => stageDesktopArtifacts([join(sample.paths.staging, 'mac-arm64', 'ContextFlow.app')], sample.paths), /顶层普通文件/);
  } finally { sample.close(); }
});
test('Mac unsigned channel seals bundle integrity without borrowing a certificate or weakening signed release settings', async () => {
  const sample = fixture();
  try {
    const directory = join(sample.root, 'desktop', 'build'); mkdirSync(directory, { recursive: true });
    for (const [platform, channel, expected] of [
      ['darwin', 'preview', { identity: '-', hardenedRuntime: false, notarize: false }],
      ['darwin', 'direct', { identity: '-', hardenedRuntime: false, notarize: false }],
      ['darwin', 'release', undefined], ['win32', 'preview', undefined],
    ]) {
      writeFileSync(join(directory, 'target.json'), JSON.stringify({ platform, channel }));
      await packageDesktop({ repository: sample.root, argv: ['--dir'], build: async options => {
        assert.deepEqual(options.config.mac, expected); assert.equal(options.publish, 'never'); return [];
      } });
    }
    const check = readFileSync(new URL('../tools/check-desktop-package.mjs', import.meta.url), 'utf8');
    assert.match(check, /\['--verify', '--deep', '--strict', target\]/, 'packaged app integrity cannot be confused with just starting the bundled Node');
    const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
    assert.match(main, /const preview = development \|\|[^;]+\.channel === 'preview';/, 'direct distribution must not allow a development extension ID just because it lacks a certificate');
    const prepare = readFileSync(new URL('../tools/prepare-desktop.mjs', import.meta.url), 'utf8');
    assert.match(prepare, /includes\('--release'\) && process\.argv\.includes\('--direct'\)/, 'signed release and direct distribution flags cannot be mixed');
  } finally { sample.close(); }
});
test('CLI cannot override staging, publish, or escape the artifact directory', () => {
  for (const argv of [['--config.directories.output=/Applications'], ['--publish', 'always'], ['--artifact-subdir', '../escape'], ['--artifact-subdir', '/tmp/output'], ['--mac', '--win'], ['--arm64', '--x64']]) assert.throws(() => parseDesktopBuildArgs(argv));
  assert.deepEqual(parseDesktopBuildArgs(['--win', '--x64', '--artifact-subdir', 'product-preview']), { options: { win: [], x64: true }, artifactSubdir: 'product-preview' });
  assert.deepEqual(parseDesktopBuildArgs(['--mac', '--target', 'dmg', '--arm64']).options, { mac: ['dmg'], arm64: true });
  assert.deepEqual(parseDesktopBuildArgs(['--mac', 'dmg', '--arm64']).options, { mac: ['dmg'], arm64: true });
  assert.deepEqual(parseDesktopBuildArgs(['--win', '--target', 'nsis', '--x64']).options, { win: ['nsis'], x64: true });
  for (const argv of [['--mac', '--target', 'nsis'], ['--win', 'dmg'], ['--mac', 'other'], ['--dir', '--target', 'zip']]) assert.throws(() => parseDesktopBuildArgs(argv));
});
test('Windows installer, Mac archive and generated sidecars remain byte-identical deliverables', async () => {
  const sample = fixture();
  try {
    const result = await packageDesktop({ repository: sample.root, argv: ['--win', '--x64', '--artifact-subdir', 'product-preview'], build: async options => {
      assert.equal(options.projectDir, join(sample.root, 'desktop'));
      const names = ['ContextFlow-1.0.0-win-x64.exe', 'ContextFlow-1.0.0-win-x64.exe.blockmap', 'ContextFlow-1.0.0-mac-arm64.zip'];
      return names.map(name => { const file = join(options.config.directories.output, name); writeFileSync(file, Buffer.from([0, 255, 17])); return file; });
    } });
    assert.equal(result.artifacts, sample.paths.artifacts);
    assert.equal(result.files.length, 5);
    for (const file of result.files.filter(file => !file.endsWith('.sha256'))) assert.deepEqual(readFileSync(file), Buffer.from([0, 255, 17]));
    for (const file of result.files.filter(file => file.endsWith('.sha256'))) assert.match(readFileSync(file, 'utf8'), /^[a-f0-9]{64}  ContextFlow-[^\n]+\n$/);
  } finally { sample.close(); }
});
test('Delivery rejects files outside staging and symbolic links without modifying their targets', () => {
  const sample = fixture();
  try {
    const outside = join(sample.root, 'ContextFlow-1.0.0-mac-arm64.dmg'); writeFileSync(outside, 'private untouched');
    assert.throws(() => stageDesktopArtifacts([outside], sample.paths), /顶层普通文件/);
    if (process.platform !== 'win32') {
      const link = join(sample.paths.staging, basename(outside)); symlinkSync(outside, link);
      assert.throws(() => stageDesktopArtifacts([link], sample.paths), /顶层普通文件/);
    }
    assert.equal(readFileSync(outside, 'utf8'), 'private untouched');
  } finally { sample.close(); }
});
test('A symlinked output ancestor is rejected before building or copying to another directory', async () => {
  if (process.platform === 'win32') return;
  const sample = fixture();
  try {
    const outside = join(sample.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(sample.root, 'release', 'desktop'));
    const file = join(sample.paths.staging, 'ContextFlow-1.0.0-mac-arm64.dmg'); writeFileSync(file, 'installer');
    assert.throws(() => stageDesktopArtifacts([file], sample.paths), /不能是符号链接/);
    assert.deepEqual(readdirSync(outside), []);
    const secondRoot = join(sample.root, 'second'); mkdirSync(secondRoot); mkdirSync(join(secondRoot, 'release'));
    symlinkSync(outside, join(secondRoot, 'release', '.desktop-build.noindex'));
    let called = false;
    await assert.rejects(packageDesktop({ repository: secondRoot, argv: ['--dir'], build: async () => { called = true; return []; } }), /不能是符号链接/);
    assert.equal(called, false);
    assert.deepEqual(readdirSync(outside), []);
  } finally { sample.close(); }
});
test('The real electron-builder resource copier retains every core production dependency outside the repository', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const requireDesktop = createRequire(new URL('../desktop/package.json', import.meta.url));
  const { getFileMatchers, copyFiles } = requireDesktop('app-builder-lib/out/fileMatcher.js');
  const config = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).build;
  const modules = config.extraResources.find(row => row.from === 'build/core/node_modules');
  assert.deepEqual(modules, { from: 'build/core/node_modules', to: 'core/node_modules', filter: ['**/*'] }, 'node_modules 需要独立 FileSet，不能仅依赖 core 根目录 glob');
  assert.notEqual(config.disableDefaultIgnoredFiles, true, '不通过全局关闭忽略规则打包开发依赖或私有文件');
  const temporary = mkdtempSync(join(tmpdir(), 'contextflow-resource-deps-'));
  try {
    const project = join(temporary, 'source-desktop'), sourceCore = join(project, 'build/core');
    mkdirSync(sourceCore, { recursive: true });
    writeFileSync(join(sourceCore, 'package.json'), JSON.stringify({ type: 'module' }));
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const production = Object.entries(lock.packages).filter(([name, value]) => name && !value.dev && !value.optional).map(([name]) => name);
    assert.ok(production.includes('node_modules/@anthropic-ai/sdk'));
    assert.ok(production.includes('node_modules/ws'));
    assert.ok(production.includes('node_modules/standardwebhooks'));
    for (const name of production) cpSync(join(root, name), join(sourceCore, name), { recursive: true });
    writeFileSync(join(sourceCore, 'probe.mjs'), `
      import assert from 'node:assert/strict';
      import { fileURLToPath } from 'node:url';
      import Anthropic from '@anthropic-ai/sdk';
      import WebSocket from 'ws';
      import { Webhook } from 'standardwebhooks';
      const base = fileURLToPath(new URL('./node_modules/', import.meta.url));
      for (const name of ['@anthropic-ai/sdk', 'ws', 'standardwebhooks']) assert.ok(fileURLToPath(import.meta.resolve(name)).startsWith(base));
      assert.equal(typeof new Anthropic({ apiKey: 'isolated-test-not-a-real-key' }).messages.create, 'function');
      assert.equal(typeof WebSocket, 'function');
      assert.equal(typeof new Webhook(Buffer.alloc(32).toString('base64')).sign('fixture', new Date(0), '{}'), 'string');
      console.log('isolated-production-imports-ok');
    `);
    const mappings = config.extraResources.filter(row => ['core', 'core/node_modules'].includes(row.to));
    async function copy(destination, resources) {
      const matchers = getFileMatchers({ extraResources: resources }, 'extraResources', destination, {
        defaultSrc: project, globalOutDir: join(temporary, 'build-output.noindex'), customBuildOptions: {}, macroExpander: value => value,
      });
      await copyFiles(matchers, undefined, false);
    }
    const oldResources = join(temporary, 'old-resources');
    await copy(oldResources, mappings.filter(row => row.to === 'core'));
    assert.equal(existsSync(join(oldResources, 'core/node_modules/@anthropic-ai/sdk/package.json')), false, '回归必须重现旧映射丢失根 node_modules 的问题');
    const resources = join(temporary, 'resources'); await copy(resources, mappings);
    const walk = (directory, relative = '') => readdirSync(join(directory, relative)).flatMap(name => {
      const entry = join(relative, name), info = lstatSync(join(directory, entry));
      return info.isDirectory() ? walk(directory, entry) : [entry];
    });
    let checked = 0;
    for (const name of production) {
      const original = join(sourceCore, name), copied = join(resources, 'core', name);
      for (const file of walk(original)) {
        assert.deepEqual(readFileSync(join(copied, file)), readFileSync(join(original, file)), `生产依赖文件丢失或变化：${name}/${file}`); checked++;
      }
    }
    assert.ok(checked > 100, '真实依赖目录应包含完整运行时，而不是几个 package.json 占位文件');
    const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
    assert.throws(() => execFileSync(process.execPath, ['--no-global-search-paths', join(oldResources, 'core/probe.mjs')], { cwd: temporary, env, stdio: 'pipe' }), /ERR_MODULE_NOT_FOUND/);
    assert.match(execFileSync(process.execPath, ['--no-global-search-paths', join(resources, 'core/probe.mjs')], { cwd: temporary, env, encoding: 'utf8', stdio: 'pipe' }), /isolated-production-imports-ok/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Native menu-bar helper is an explicit executable resource and signed macOS binary, never a Windows build requirement', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).build;
  const native = config.extraResources.find(row => row.to === 'native');
  assert.deepEqual(native, { from: 'build/native', to: 'native' });
  assert.ok(config.mac.binaries.includes('Contents/Resources/native/menu-bar'));
  const prepare = readFileSync(join(root, 'tools/prepare-desktop.mjs'), 'utf8');
  assert.match(prepare, /if \(platform === 'darwin'\)[\s\S]*?execFileSync\('xcrun', \['clang'/);
  assert.match(prepare, /\[core, runtime, native\]/, 'switching targets removes the preceding platform executable');
  assert.match(prepare, /'desktop\/native\/menu-bar\.m'/, 'native source is included in stale-build hashing');
  assert.match(prepare, /'tools\/prepare-desktop\.mjs'/, 'compiler flag changes invalidate the prepared build');
  assert.match(prepare, /-mmacosx-version-min=12\.0/);
  const requireDesktop = createRequire(new URL('../desktop/package.json', import.meta.url));
  const { getFileMatchers, copyFiles } = requireDesktop('app-builder-lib/out/fileMatcher.js');
  const temporary = mkdtempSync(join(tmpdir(), 'contextflow-native-resource-'));
  try {
    const project = join(temporary, 'source-desktop'); mkdirSync(join(project, 'build/native'), { recursive: true });
    const copy = async destination => {
      const matchers = getFileMatchers({ extraResources: [native] }, 'extraResources', destination, {
        defaultSrc: project, globalOutDir: join(temporary, 'build-output.noindex'), customBuildOptions: {}, macroExpander: value => value,
      });
      await copyFiles(matchers, undefined, false);
    };
    const windowsResources = join(temporary, 'windows-resources'); await copy(windowsResources);
    assert.equal(existsSync(join(windowsResources, 'native/menu-bar')), false, 'empty Windows native source cannot inherit a stale Mac helper');
    writeFileSync(join(project, 'build/native/menu-bar'), 'isolated executable resource fixture', { mode: 0o755 });
    const macResources = join(temporary, 'mac-resources'); await copy(macResources);
    assert.equal(readFileSync(join(macResources, 'native/menu-bar'), 'utf8'), 'isolated executable resource fixture');
    if (process.platform !== 'win32') assert.ok(lstatSync(join(macResources, 'native/menu-bar')).mode & 0o111);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('Public AppKit geometry helper compiles for macOS 12 and emits finite Electron-coordinate display rectangles', { skip: process.platform !== 'darwin' }, () => {
  const source = fileURLToPath(new URL('../desktop/native/menu-bar.m', import.meta.url));
  const text = readFileSync(source, 'utf8');
  for (const forbidden of ['NSApplication', 'NSWindow', 'CGWindow', 'AXUIElement', 'AppleScript', 'AuthorizationCreate', 'CGRequestScreenCaptureAccess', 'NSAppleScript']) {
    assert.ok(!text.includes(forbidden), `geometry helper must not acquire ${forbidden} capability`);
  }
  const temporary = mkdtempSync(join(tmpdir(), 'contextflow-native-geometry-'));
  try {
    const binary = join(temporary, 'menu-bar');
    execFileSync('xcrun', ['clang', '-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=12.0',
      '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-O2', '-framework', 'AppKit', source, '-o', binary], { timeout: 30000, stdio: 'pipe' });
    const result = JSON.parse(execFileSync(binary, [], { encoding: 'utf8', timeout: 5000 }));
    assert.deepEqual(Object.keys(result), ['screens']); assert.ok(result.screens.length > 0);
    for (const screen of result.screens) {
      assert.deepEqual(Object.keys(screen).sort(), ['frame', 'left', 'right']);
      for (const [name, rect] of Object.entries(screen)) {
        if (rect === null && name !== 'frame') continue;
        assert.deepEqual(Object.keys(rect).sort(), ['height', 'width', 'x', 'y']);
        assert.ok(Object.values(rect).every(Number.isFinite)); assert.ok(rect.width > 0 && rect.height > 0);
        if (name !== 'frame') {
          assert.ok(rect.x >= screen.frame.x - 0.01 && rect.y >= screen.frame.y - 0.01);
          assert.ok(rect.x + rect.width <= screen.frame.x + screen.frame.width + 0.01);
          assert.ok(rect.y + rect.height <= screen.frame.y + screen.frame.height + 0.01);
        }
      }
    }
    assert.equal(result.screens[0].frame.y, 0, 'primary screen maximum AppKit Y is Electron global top zero');
    assert.throws(() => execFileSync(binary, ['unexpected-argument'], { timeout: 5000, stdio: 'pipe' }), error => error.status === 64);
    const commands = execFileSync('/usr/bin/otool', ['-l', binary], { encoding: 'utf8', timeout: 5000 });
    assert.match(commands, /minos 12\.0(?:\s|$)/, 'the helper must support the declared minimum macOS rather than the build host version');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
