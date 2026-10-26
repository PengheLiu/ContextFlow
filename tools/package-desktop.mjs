// Keep runnable build products out of Spotlight; expose only distributable
// files in release/desktop. Never launch, move or unregister an installed app.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ensureArtifactDirectory, publishImmutableArtifacts } from './artifact-output.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktopRequire = createRequire(new URL('../desktop/package.json', import.meta.url));
const inside = (directory, file) => {
  const value = relative(directory, file);
  return !!value && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
};

export function desktopBuildPaths(repository = root, artifactSubdir = '') {
  if (artifactSubdir && (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(artifactSubdir))) throw new Error('交付子目录仅接受单个字母、数字、横线或下划线名称。');
  return {
    repository: resolve(repository),
    projectDir: join(repository, 'desktop'),
    staging: join(repository, 'release', '.desktop-build.noindex'),
    artifacts: join(repository, 'release', 'desktop', artifactSubdir),
  };
}

function ensureBuildDirectory(directory, repository) {
  ensureArtifactDirectory(directory, repository);
}

export function parseDesktopBuildArgs(argv) {
  const options = {}, selected = { platform: null, arch: null };
  let artifactSubdir = '', target = '';
  const selectTarget = value => {
    if (target || !['dmg', 'zip', 'nsis'].includes(value)) throw new Error('构建目标只支持单个 dmg、zip 或 nsis。');
    target = value;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--mac', '--win'].includes(flag)) {
      if (selected.platform) throw new Error('一次只构建一个系统，请分别准备对应运行时。');
      selected.platform = flag.slice(2); options[selected.platform] = [];
      if (argv[index + 1] && !argv[index + 1].startsWith('--')) selectTarget(argv[++index]);
    } else if (['--arm64', '--x64'].includes(flag)) {
      if (selected.arch) throw new Error('一次只构建一个架构，请分别准备对应运行时。');
      selected.arch = flag.slice(2); options[selected.arch] = true;
    } else if (flag === '--dir') options.dir = true;
    else if (flag === '--target') selectTarget(argv[++index]);
    else if (flag === '--artifact-subdir') {
      if (artifactSubdir || !argv[index + 1]) throw new Error('请为 --artifact-subdir 提供一个交付子目录。');
      artifactSubdir = argv[++index];
    } else throw new Error(`不支持的构建选项：${flag}。不要覆盖构建输出目录；交付隔离请使用 --artifact-subdir。`);
  }
  if (target) {
    if (options.dir) throw new Error('--dir 不生成安装包，不能同时指定 --target。');
    const platform = selected.platform || (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : '');
    if (platform === 'mac' && ['dmg', 'zip'].includes(target) || platform === 'win' && target === 'nsis') options[platform] = [target];
    else throw new Error('构建目标与系统不匹配：mac 仅支持 dmg / zip，win 仅支持 nsis。');
  }
  desktopBuildPaths(root, artifactSubdir);
  return { options, artifactSubdir };
}

function checkedFile(file, staging) {
  const source = resolve(file);
  if (!inside(staging, source) || relative(staging, source) !== basename(source) || !lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) {
    throw new Error('交付文件必须是 noindex 暂存目录内的顶层普通文件。');
  }
  if (!inside(realpathSync(staging), realpathSync(source))) throw new Error('拒绝从暂存目录外复制文件。');
  return source;
}

function currentUpdateMetadata(staging, names, parse) {
  const output = [];
  for (const name of readdirSync(staging)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.ya?ml$/.test(name)) continue;
    const file = checkedFile(join(staging, name), staging);
    let metadata;
    try { metadata = parse(readFileSync(file, 'utf8')); } catch { continue; }
    const references = [...new Set([metadata?.path, ...(Array.isArray(metadata?.files) ? metadata.files.map(row => row?.url) : [])].filter(Boolean))];
    // Do not copy stale update metadata from another OS/architecture build.
    if (references.length && references.every(value => typeof value === 'string' && names.has(value))) output.push(file);
  }
  return output;
}

export function stageDesktopArtifacts(files, { staging, artifacts, repository = dirname(dirname(staging)), parseMetadata = text => desktopRequire('js-yaml').load(text) }) {
  const sources = [...new Set(files.map(file => checkedFile(file, staging)))];
  for (const file of sources) {
    if (!/^ContextFlow-[a-zA-Z0-9._-]+\.(?:dmg|exe|zip)(?:\.blockmap)?$/.test(basename(file))) throw new Error(`不是允许交付的 ContextFlow 安装文件：${basename(file)}`);
  }
  if (!sources.some(file => /\.(?:dmg|exe|zip)$/.test(file))) throw new Error('本次构建没有生成可交付安装包；未复制旧产物。');
  const names = new Set(sources.map(file => basename(file)));
  sources.push(...currentUpdateMetadata(staging, names, parseMetadata));
  ensureBuildDirectory(artifacts, repository);
  const output = [];
  for (const file of sources) {
    const name = basename(file), bytes = readFileSync(file);
    output.push({ name, bytes });
    if (/\.(?:dmg|exe|zip)$/.test(name)) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      output.push({ name: `${name}.sha256`, bytes: `${digest}  ${name}\n` });
    }
  }
  return publishImmutableArtifacts(output, { directory: artifacts, repository });
}

export async function packageDesktop({ argv = [], repository = root, build = options => desktopRequire('electron-builder').build(options) } = {}) {
  const { options, artifactSubdir } = parseDesktopBuildArgs(argv);
  const paths = desktopBuildPaths(repository, artifactSubdir);
  ensureBuildDirectory(paths.staging, paths.repository);
  const config = { directories: { output: paths.staging } };
  const metadataFile = join(paths.projectDir, 'build', 'target.json');
  if (existsSync(metadataFile)) {
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    if (metadata.platform === 'darwin' && ['preview', 'direct'].includes(metadata.channel)) {
      // Seal our own bundle and nested code instead of keeping Electron's stale
      // linker signature. Ad-hoc integrity is not a Developer ID or notarization.
      // Hardened library validation cannot bind an anonymous signature to Apple's
      // prebuilt framework identity. Signed release builds retain their defaults.
      config.mac = { identity: '-', hardenedRuntime: false, notarize: false };
    }
  }
  const files = await build({ ...options, projectDir: paths.projectDir, publish: 'never', config });
  return { ...paths, files: options.dir ? [] : stageDesktopArtifacts(files, paths) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageDesktop({ argv: process.argv.slice(2) });
    console.log(`Unpacked build (not for installation): ${result.staging}`);
    if (result.files.length) console.log(`Deliverable files only:\n${result.files.join('\n')}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
