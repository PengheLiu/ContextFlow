// Build-time only. End users never run npm or download a runtime on first use.
import { mkdirSync, cpSync, copyFileSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import esbuild from 'esbuild';
import { runtimeFiles } from './package-store-support.mjs';
import { renderTrayTemplate } from '../desktop/tray-icon.mjs';
import { NODE_LICENSE_VERSION, installNodeLicense } from './node-license.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function prepareTrayAssets() {
  const ui = join(root, 'desktop', 'ui'); mkdirSync(ui, { recursive: true });
  copyFileSync(join(root, 'assets', 'toolbar-128.png'), join(ui, 'icon.png'));
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const bytes = renderTrayTemplate(size);
    writeFileSync(join(root, 'assets', name), bytes); writeFileSync(join(ui, name), bytes);
  }
}
if (process.argv.includes('--tray-assets-only')) { prepareTrayAssets(); console.log('Desktop tray assets prepared: monochrome 16px + 32px @2x.'); process.exit(0); }
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const platform = process.argv.includes('--platform') ? arg('--platform') : process.platform;
const arch = process.argv.includes('--arch') ? arg('--arch') : process.arch;
if (process.argv.includes('--release') && process.argv.includes('--direct')) throw new Error('--direct 与 --release 不能同时使用。');
const channel = process.argv.includes('--release') ? 'release' : process.argv.includes('--direct') ? 'direct' : 'preview';
const VERSION = NODE_LICENSE_VERSION;
const hashes = {
  'darwin-arm64': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  'darwin-x64': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  'win32-x64': 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
  'win32-arm64': '8bea91dc437fe01e7d92ef0efc6c9eaf654369aaba9b2d3e9841552ea7b95a00',
};
const target = `${platform}-${arch}`;
if (!hashes[target]) throw new Error(`不支持的桌面构建目标 ${target}`);
const build = join(root, 'desktop', 'build'), core = join(build, 'core'), runtime = join(build, 'runtime'), native = join(build, 'native');
mkdirSync(build, { recursive: true });
// Exact disposable build targets only; never delete release assets or user data.
for (const directory of [core, runtime, native]) { rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true }); }
if (platform === 'darwin') {
  if (process.platform !== 'darwin') throw new Error('macOS 原生几何助手需要在 macOS 构建机上编译。');
  const helper = join(native, 'menu-bar');
  execFileSync('xcrun', ['clang', '-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=12.0',
    '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-O2', '-framework', 'AppKit',
    join(root, 'desktop', 'native', 'menu-bar.m'), '-o', helper], { stdio: 'inherit' });
  chmodSync(helper, 0o755);
}
for (const file of [...runtimeFiles, 'package.json']) {
  mkdirSync(dirname(join(core, file)), { recursive: true }); copyFileSync(join(root, file), join(core, file));
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// On Windows npm.cmd cannot be execFile'd safely. Invoke npm's JS entrypoint
// through the build machine's Node, without a command shell.
const npmCLI = process.env.npm_execpath;
if (npmCLI && /npm-cli\.js$/.test(npmCLI)) execFileSync(process.execPath, [npmCLI, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: core, stdio: 'inherit' });
else if (process.platform !== 'win32') execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: core, stdio: 'inherit' });
else throw new Error('Windows 构建请通过 npm run desktop:prepare 启动。');

const file = platform === 'win32' ? `win-${arch}/node.exe` : `node-v${VERSION}-darwin-${arch}.tar.gz`;
const cache = join(root, 'desktop', '.cache'); mkdirSync(cache, { recursive: true });
const archive = join(cache, `node-${VERSION}-${target}${platform === 'win32' ? '.exe' : '.tar.gz'}`);
if (!existsSync(archive) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== hashes[target]) {
  const response = await fetch(`https://nodejs.org/dist/v${VERSION}/${file}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`运行时下载失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== hashes[target]) throw new Error('运行时 SHA-256 校验失败，拒绝构建');
  writeFileSync(archive, bytes);
}
if (platform === 'win32') copyFileSync(archive, join(runtime, 'node.exe'));
else {
  const unpacked = join(build, 'unpacked-node'); mkdirSync(unpacked, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', unpacked, '--strip-components=1']);
  copyFileSync(join(unpacked, 'bin', 'node'), join(runtime, 'node')); chmodSync(join(runtime, 'node'), 0o755);
  await installNodeLicense({ cacheDir: cache, output: join(runtime, 'NODE-LICENSE'), sourceBytes: readFileSync(join(unpacked, 'LICENSE')) });
  rmSync(unpacked, { recursive: true, force: true });
}
if (platform === 'win32') {
  await installNodeLicense({ cacheDir: cache, output: join(runtime, 'NODE-LICENSE') });
}
const uiBuild = await esbuild.build({ entryPoints: [join(root, 'desktop', 'ui', 'renderer.js')], outfile: join(root, 'desktop', 'ui', 'app.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome130', charset: 'ascii',
  define: { __CONTEXTFLOW_TOKEN__: '""' }, legalComments: 'none', metafile: true });
prepareTrayAssets();
const desktopSources = readdirSync(join(root, 'desktop')).filter(file => /\.(?:mjs|cjs)$/.test(file) && file !== 'smoke.mjs')
  .map(file => `desktop/${file}`);
writeFileSync(join(build, 'target.json'), JSON.stringify({ platform, arch, node: VERSION, sha256: hashes[target],
  sources: Object.fromEntries([...runtimeFiles, 'package.json', 'desktop/package.json', ...desktopSources,
    'desktop/ui/index.html', 'desktop/ui/styles.css', 'desktop/native/menu-bar.m', 'tools/prepare-desktop.mjs', 'tools/node-license.mjs',
    'assets/trayTemplate.svg', 'assets/trayTemplate.png', 'assets/trayTemplate@2x.png',
    ...Object.keys(uiBuild.metafile.inputs).map(file => relative(root, file))]
    .map(file => [file.replaceAll('\\', '/'), createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])),
  channel }, null, 2));
console.log(`Desktop prepared: ${target}, Node ${VERSION} (SHA-256 verified)`);
