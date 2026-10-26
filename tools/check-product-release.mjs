// Read-only release gate. A report is evidence to review, not a signature,
// notarization, human usability study, Chrome approval or permission to publish.
import { readFileSync, lstatSync, realpathSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join, dirname, basename, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const requireDesktop = createRequire(new URL('../desktop/package.json', import.meta.url));
export const RELEASE_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];
export const UNSIGNED_MAC_RELEASE = Object.freeze({ target: 'darwin-arm64', version: '1.1.0', releaseTag: 'v1.1.0',
  artifact: 'ContextFlow-1.1.0-mac-arm64.dmg' });
// Explicitly reviewed independent distributions; adding a version never
// authorizes another platform, a signing claim or reuse of a frozen tag.
export const UNSIGNED_MAC_RELEASES = Object.freeze([UNSIGNED_MAC_RELEASE,
  Object.freeze({ target: 'darwin-arm64', version: '1.1.1', releaseTag: 'v1.1.1', artifact: 'ContextFlow-1.1.1-mac-arm64.dmg' })]);
export const EVIDENCE_BOUNDARY = '本检查只核验文件、引用和验收证据的一致性；不亲自执行签名、公证、安装、升级或商店审核，不证明报告不可伪造，也不授权发布。';
const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const version = value => typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
  && value.split('.').every(part => Number.isSafeInteger(Number(part)));
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function unsignedDownload(row, target) {
  const approved = UNSIGNED_MAC_RELEASES.find(release => release.version === row.version);
  if (!approved) fail(`未签名下载必须绑定已核对的 Mac ARM 发行、文件、摘要和验证范围：${target}`);
  const url = `https://github.com/PengheLiu/ContextFlow/releases/download/${approved.releaseTag}/${approved.artifact}`;
  if (target !== approved.target || row.version !== approved.version || row.releaseTag !== approved.releaseTag
    || row.artifact !== approved.artifact || row.validation !== 'local-package-verified' || row.signing !== 'unsigned-unnotarized'
    || !sha256(row.sha256) || !date(row.checkedAt) || row.downloadUrl !== url || row.checksumUrl !== `${url}.sha256`
    || ['signed', 'notarized'].some(key => key in row)) fail(`未签名下载必须绑定已核对的 Mac ARM 发行、文件、摘要和验证范围：${target}`);
}
const later = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
};
function readJSON(file, limit = 1024 * 1024) {
  if (!lstatSync(file).isFile() || lstatSync(file).size > limit) fail(`不是有效的小型 JSON 文件：${basename(file)}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The sole public-status record. Missing data must never imply a release. */
export function sourceReleaseState(repository = ROOT) {
  const state = readJSON(join(repository, 'product/release.json'));
  if (state.schemaVersion !== 1 || !version(state.candidateVersion) || !['preview', 'release'].includes(state.channel)) fail('公开状态记录的 schema、候选版本或渠道无效。');
  const extension = state.publishedExtension, github = state.publishedGithub;
  if (!record(extension) || !version(extension.version) || extension.status !== 'published' || !date(extension.checkedAt)
    || extension.storeId !== 'aemncphfnlpbhlddifhohpgegejjejfm') fail('已公开扩展的版本、核查日期或商店 ID 无效。');
  if (!record(github) || !version(github.version) || github.tag !== `v${github.version}` || !commit(github.commit) || !date(github.checkedAt)) fail('已公开 GitHub 冻结版本记录无效。');
  for (const published of [extension.version, github.version]) if (later(published, state.candidateVersion)) fail('候选版本不能低于已公开版本。');
  const platforms = state.desktop?.platforms;
  if (!['manual', 'auto'].includes(state.desktop?.updateMode)) fail('必须明确桌面端使用手动更新还是自动更新。');
  if (!record(platforms) || Object.keys(platforms).length !== RELEASE_TARGETS.length) fail('必须分别声明四个桌面系统 / 架构状态。');
  for (const target of RELEASE_TARGETS) {
    const row = platforms[target];
    if (!record(row) || !['unpublished', 'available-unsigned', 'published'].includes(row.status)
      || !['not-verified', 'local-preview-verified', 'local-package-verified', 'release-verified'].includes(row.validation)) fail(`桌面目标状态无效：${target}`);
    if (row.status === 'available-unsigned') {
      unsignedDownload(row, target);
      if (later(row.version, state.candidateVersion)) fail('桌面下载版本不能高于当前源码版本。');
      if (state.desktop.updateMode !== 'manual') fail('未签名下载只能手动安装，不能启用自动更新。');
    }
    if (row.status === 'published' && (row.validation !== 'release-verified' || !version(row.version) || !nonempty(row.manifest))) fail(`正式下载必须关联发行版本与验收清单：${target}`);
    if (row.status === 'unpublished' && ['url', 'download', 'signed', 'notarized'].some(key => key in row)) fail(`未发布目标不得伪造下载或签名承诺：${target}`);
  }
  const versions = [];
  for (const prefix of ['', 'desktop/']) {
    const pkg = readJSON(join(repository, `${prefix}package.json`)), lock = readJSON(join(repository, `${prefix}package-lock.json`));
    versions.push([`${prefix}package.json`, pkg.version], [`${prefix}package-lock.json`, lock.version], [`${prefix}package-lock.json packages[""]`, lock.packages?.['']?.version]);
  }
  for (const [file, value] of versions) if (value !== state.candidateVersion) fail(`版本不一致：${file}=${value}，候选=${state.candidateVersion}`);
  return { ...state, releaseReady: false, evidenceBoundary: EVIDENCE_BOUNDARY,
    notes: ['本机验证与未签名下载不是正式签名发行。', '公开状态是 checkedAt 当日的记录；离线检查不冒充实时核验。', '正式签名发行还须 --release --manifest，通过源代码、安装包和验收证据门禁。'] };
}

/** Optional local byte check for the explicitly authorized unsigned download.
 * Does not publish, run the installer, imply notarization or skip --release. */
export function checkUnsignedDesktopFiles(directory, state = sourceReleaseState()) {
  const row = state.desktop?.platforms?.[UNSIGNED_MAC_RELEASE.target];
  if (row?.status !== 'available-unsigned') fail('当前没有授权的未签名 Mac ARM 下载记录。');
  unsignedDownload(row, UNSIGNED_MAC_RELEASE.target);
  const actual = hashFile(artifactPath(directory, row.artifact));
  if (actual.sha256 !== row.sha256 || actual.size <= 0) fail('未签名 Mac 安装包的实际摘要与公开状态不一致。');
  const checksum = readFileSync(artifactPath(directory, `${row.artifact}.sha256`), 'utf8').trim();
  if (checksum !== `${actual.sha256}  ${row.artifact}`) fail('未签名 Mac 安装包的校验侧车不匹配。');
  return { target: UNSIGNED_MAC_RELEASE.target, version: row.version, releaseTag: row.releaseTag, artifact: row.artifact,
    sha256: actual.sha256, size: actual.size, signing: row.signing, validation: row.validation,
    downloadUrl: row.downloadUrl, checksumUrl: row.checksumUrl, releaseReady: false, evidenceBoundary: EVIDENCE_BOUNDARY };
}

function artifactPath(directory, name) {
  if (!nonempty(name) || name !== basename(name) || /[\\/\0\r\n]/.test(name) || name === '.' || name === '..') fail('发行清单中的文件必须是同一交付目录的顶层文件。');
  const file = join(directory, name), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`发行文件不是普通文件：${name}`);
  const path = relative(realpathSync(directory), realpathSync(file));
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) fail('发行文件解析后越出交付目录。');
  return file;
}
function hashFile(file) {
  const h256 = createHash('sha256'), h512 = createHash('sha512'), chunk = Buffer.alloc(1024 * 1024);
  const descriptor = openSync(file, 'r'); let size = 0;
  try {
    for (let length; (length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0;) {
      size += length; h256.update(chunk.subarray(0, length)); h512.update(chunk.subarray(0, length));
    }
  } finally { closeSync(descriptor); }
  return { size, sha256: h256.digest('hex'), sha512: h512.digest('base64') };
}
const installerName = (v, target, ext) => `ContextFlow-${v}-${target.replace('darwin', 'mac').replace('win32', 'win')}.${ext}`;
const commandRules = {
  'mac-signature': { command: 'codesign', args: ['--verify', '--strict'] },
  'mac-notarization': { command: 'xcrun', args: ['notarytool', 'info'], accepted: 'Accepted' },
  'mac-staple': { command: 'xcrun', args: ['stapler', 'validate'] },
  'mac-gatekeeper': { command: 'spctl', args: ['--assess'] },
  'windows-signature': { command: 'signtool', args: ['verify', '/pa'] },
};
const manualChecks = ['clean-install', 'browser-connect', 'reading-and-sync', 'close-reopen', 'sleep-resume', 'uninstall-preserves-data'];
function validateEvidence(evidence, target, manifest, artifacts) {
  if (evidence.format !== 'ContextFlowDesktopReleaseEvidence' || evidence.schemaVersion !== 1 || evidence.target !== target
    || evidence.version !== manifest.version || evidence.sourceCommit !== manifest.sourceCommit || evidence.updateMode !== manifest.updateMode
    || !date(evidence.observedAt)) fail(`验收报告未绑定本次目标 / 版本 / 源码 / 更新方式：${target}`);
  const [platform, arch] = target.split('-');
  if (evidence.environment?.platform !== platform || evidence.environment.arch !== arch || !nonempty(evidence.environment.osVersion)) fail(`验收必须来自对应目标系统 / 架构：${target}`);
  const own = artifacts.filter(file => file.target === target && /\.(?:dmg|zip|exe)$/.test(file.name));
  if (!record(evidence.artifacts) || own.some(file => evidence.artifacts[file.name] !== file.sha256)) fail(`验收报告的安装包哈希不匹配：${target}`);
  const checks = evidence.checks;
  if (!Array.isArray(checks) || checks.length > 64 || new Set(checks.map(check => check?.id)).size !== checks.length) fail(`验收检查缺失、重复或无效：${target}`);
  const required = platform === 'darwin' ? ['mac-signature', 'mac-notarization', 'mac-staple', 'mac-gatekeeper'] : ['windows-signature'];
  for (const id of required) {
    const check = checks.find(row => row?.id === id), rule = commandRules[id];
    if (!record(check) || check.method !== 'command' || check.exitCode !== 0 || check.command !== rule.command || !Array.isArray(check.args)
      || !rule.args.every(arg => check.args.includes(arg)) || typeof check.output !== 'string' || check.output.trim().length < 8
      || !sha256(check.outputSha256) || createHash('sha256').update(check.output).digest('hex') !== check.outputSha256 || !nonempty(check.observation)
      || rule.accepted && check.result !== rule.accepted) fail(`缺少完整命令验收证据：${target}/${id}`);
  }
  const workflowChecks = [...manualChecks, ...(manifest.updateMode === 'auto' ? ['signed-upgrade', 'failed-update-recovery'] : ['manual-overwrite-preserves-data'])];
  for (const id of workflowChecks) {
    const check = checks.find(row => row?.id === id);
    if (!record(check) || check.method !== 'manual' || check.outcome !== 'passed' || !nonempty(check.reviewer)
      || typeof check.observation !== 'string' || check.observation.trim().length < 12
      || !Array.isArray(check.steps) || !check.steps.length || check.steps.some(step => typeof step !== 'string' || step.trim().length < 4)) fail(`缺少逐项实机观察，不接受 tested=true：${target}/${id}`);
  }
  if (platform === 'win32' && manifest.updateMode === 'auto' && (!Array.isArray(evidence.updatePublisherNames) || !evidence.updatePublisherNames.length
    || evidence.updatePublisherNames.some(name => !nonempty(name)))) fail(`Windows 更新必须验证实际 app-update.yml 中的发布者名称：${target}`);
}

/** Validate already-produced files and externally reviewed, hash-bound receipts.
 * No installer, model, certificate store, notarization or deployment is run. */
export function validateReleaseBundle(manifest, { directory, sourceState, sourceCommit, tagCommit, gitClean,
  parseYAML = text => requireDesktop('js-yaml').load(text) } = {}) {
  if (!record(manifest) || manifest.schemaVersion !== 1 || !version(manifest.version) || manifest.channel !== 'release') fail('正式发行清单必须声明 schemaVersion=1、正式语义版本和 release 渠道。');
  if (sourceState?.channel !== 'release' || manifest.version !== sourceState.candidateVersion) fail('源码仍为 preview 或版本不匹配，不能提交正式发行。');
  if (!['manual', 'auto'].includes(manifest.updateMode) || manifest.updateMode !== sourceState.desktop?.updateMode) fail('正式清单的更新方式必须与源码公开状态一致。');
  if (UNSIGNED_MAC_RELEASES.some(release => !later(manifest.version, release.version))) fail('v1.1.0 / v1.1.1 已保留为未签名分发，后续正式签名发行必须使用更高版本，不覆盖既有 tag。');
  if (![sourceState.publishedExtension.version, sourceState.publishedGithub.version].every(published => later(manifest.version, published))) fail('必须使用高于已公开版本的新版本，不覆盖冻结发行。');
  if (!gitClean || !commit(manifest.sourceCommit) || manifest.sourceCommit !== sourceCommit || manifest.sourceCommit !== tagCommit
    || manifest.tag !== `v${manifest.version}`) fail('源码必须已提交且干净，HEAD、版本 tag 与清单 commit 必须一致。');
  if (!Array.isArray(manifest.targets) || !manifest.targets.length || new Set(manifest.targets.map(row => row?.target)).size !== manifest.targets.length
    || manifest.targets.some(row => !record(row) || !RELEASE_TARGETS.includes(row.target))) fail('必须明确列出本次实际发行目标，不能用框架支持代替验收。');
  if (manifest.updateMode === 'auto' && manifest.targets.filter(row => row.target.startsWith('win32-')).length > 1) fail('当前 Windows 自动更新只读取一个 latest.yml，尚不能安全同时发行两个 Windows 架构。');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 64) fail('正式发行缺少明确产物清单。');
  const files = new Map();
  for (const row of manifest.artifacts) {
    if (!record(row) || !sha256(row.sha256) || !Number.isSafeInteger(row.size) || row.size <= 0 || files.has(row.name)) fail('产物清单存在无效 / 重复条目。');
    if (!/^ContextFlow-[\d.]+-(?:mac|win)-(?:arm64|x64)\.(?:dmg|zip|exe)(?:\.blockmap)?$/.test(row.name) && !['latest.yml', 'latest-mac.yml'].includes(row.name)) fail(`不允许混入其他交付文件：${row.name}`);
    const file = artifactPath(directory, row.name), actual = hashFile(file);
    if (actual.sha256 !== row.sha256 || actual.size !== row.size) fail(`实际产物摘要或大小不匹配：${row.name}`);
    if (!row.name.endsWith('.yml')) {
      if (!manifest.targets.some(target => target.target === row.target) || !row.name.startsWith(`ContextFlow-${manifest.version}-${row.target.replace('darwin', 'mac').replace('win32', 'win')}.`)) fail(`产物的版本 / 系统 / 架构不匹配：${row.name}`);
      if (row.target.startsWith('darwin-') ? /\.exe(?:\.blockmap)?$/.test(row.name) : /\.(?:dmg|zip)(?:\.blockmap)?$/.test(row.name)) fail(`安装包格式与目标系统不匹配：${row.name}`);
    }
    files.set(row.name, { ...row, ...actual, file });
  }
  // Uploading a directory glob must not silently add stale versions or targets.
  for (const name of readdirSync(directory)) if (/\.(?:dmg|zip|exe|blockmap|ya?ml)$/.test(name) && !files.has(name)) fail(`交付目录存在未列出的安装 / 更新文件：${name}`);
  for (const metadataFile of [...files.values()].filter(file => file.name.endsWith('.yml'))) {
    if (metadataFile.size > 256 * 1024) fail(`更新元数据过大：${metadataFile.name}`);
    const metadata = parseYAML(readFileSync(metadataFile.file, 'utf8'));
    if (metadata?.version !== manifest.version || !Array.isArray(metadata.files) || !metadata.files.length || metadata.files.length > 32) fail(`更新元数据的版本或文件列表无效：${metadataFile.name}`);
    for (const info of metadata.files) {
      const actual = files.get(info?.url);
      if (!actual || !/\.(?:dmg|zip|exe)$/.test(actual.name) || info.sha512 !== actual.sha512 || info.size !== actual.size
        || (metadataFile.name === 'latest-mac.yml' ? !actual.target?.startsWith('darwin-') : !actual.target?.startsWith('win32-'))) fail(`更新元数据引用未绑定实际文件 / 系统：${metadataFile.name}`);
    }
    if (metadata.path != null) {
      const actual = files.get(metadata.path);
      if (!actual || metadata.sha512 !== actual.sha512) fail(`旧版更新 path / sha512 不匹配：${metadataFile.name}`);
    }
  }
  for (const target of manifest.targets) {
    const extensions = target.target.startsWith('darwin-') ? manifest.updateMode === 'auto' ? ['dmg', 'zip'] : ['dmg'] : ['exe'];
    for (const ext of extensions) if (!files.has(installerName(manifest.version, target.target, ext))) fail(`缺少安装或自动更新所需文件：${installerName(manifest.version, target.target, ext)}`);
    for (const file of [...files.values()].filter(file => file.target === target.target && /\.(?:dmg|zip|exe)$/.test(file.name))) {
      const name = file.name;
      const sidecar = readFileSync(artifactPath(directory, `${name}.sha256`), 'utf8').trim();
      if (sidecar !== `${file.sha256}  ${name}`) fail(`SHA-256 校验侧车未绑定真实产物：${name}`);
      if (manifest.updateMode === 'auto' && !files.has(`${name}.blockmap`)) fail(`缺少更新块映射：${name}.blockmap`);
    }
    if (manifest.updateMode === 'auto') {
      const metadataName = target.target.startsWith('darwin-') ? 'latest-mac.yml' : 'latest.yml', metadataFile = files.get(metadataName);
      if (!metadataFile) fail(`缺少有效的更新元数据：${metadataName}`);
      const metadata = parseYAML(readFileSync(metadataFile.file, 'utf8')), updateExt = target.target.startsWith('darwin-') ? 'zip' : 'exe';
      if (!metadata.files.some(file => file.url === installerName(manifest.version, target.target, updateExt))) fail(`更新元数据缺少此架构的完整更新包：${target.target}`);
    }
    if (!record(target.evidence) || !sha256(target.evidence.sha256)) fail(`未提供有摘要的目标验收报告：${target.target}`);
    const reportFile = artifactPath(directory, target.evidence.name), receipt = hashFile(reportFile);
    if (receipt.sha256 !== target.evidence.sha256) fail(`目标验收报告摘要变化：${target.target}`);
    validateEvidence(readJSON(reportFile), target.target, manifest, [...files.values()]);
  }
  return { version: manifest.version, updateMode: manifest.updateMode, sourceCommit, targets: manifest.targets.map(row => row.target),
    artifacts: [...files.keys()], checksPassed: true, evidenceBoundary: EVIDENCE_BOUNDARY };
}

/** Strict mode only. Fixed public repository, read-only API routes and one
 * shared deadline. Never print gh's stderr, authentication state or payload. */
export function verifyGithubRelease(sourceState, manifest, { readAPI } = {}) {
  const deadline = Date.now() + 20000;
  const read = readAPI || (route => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail('远端发行核查超时，未放行。');
    try {
      return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', `repos/PengheLiu/ContextFlow/${route}`], {
        encoding: 'utf8', timeout: remaining, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      }));
    } catch { fail('无法只读核查 GitHub 公开发行和 tag（网络、权限或 tag 尚未推送）；未放行，也未修改远端。'); }
  });
  if (!version(manifest?.version) || manifest.tag !== `v${manifest.version}` || !commit(manifest.sourceCommit)
    || !version(sourceState?.publishedGithub?.version) || !commit(sourceState.publishedGithub.commit)) fail('远端核查前的版本 / tag 输入无效。');
  const latest = read('releases/latest'), liveVersion = typeof latest?.tag_name === 'string' ? latest.tag_name.replace(/^v/, '') : '';
  if (!version(liveVersion) || latest.draft !== false || latest.prerelease !== false) fail('GitHub 当前公开正式发行记录无效，未放行。');
  if (!later(manifest.version, liveVersion)) fail('候选版本已公开或低于实时公开版本，不能覆盖冻结发行。');
  if (liveVersion !== sourceState.publishedGithub.version) fail('公开版本记录已过期，请先核对并更新 product/release.json。');
  function remoteCommit(tag) {
    let object = read(`git/ref/tags/${tag}`)?.object;
    for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
      if (!commit(object.sha)) fail('远端 tag 对象无效，未放行。');
      object = read(`git/tags/${object.sha}`)?.object;
    }
    if (object?.type !== 'commit' || !commit(object.sha)) fail('远端 tag 未解析为固定 commit，未放行。');
    return object.sha;
  }
  if (remoteCommit(sourceState.publishedGithub.tag) !== sourceState.publishedGithub.commit) fail('已公开 tag 的冻结 commit 与记录不一致，不能继续发行。');
  if (remoteCommit(manifest.tag) !== manifest.sourceCommit) fail('候选 tag 必须已推送，并与本次源码 / 产物 commit 一致。');
  return { repository: 'PengheLiu/ContextFlow', latestVersion: liveVersion, tag: manifest.tag, sourceCommit: manifest.sourceCommit };
}

export function checkProductRelease({ repository = ROOT, release = false, manifestPath } = {}) {
  const sourceState = sourceReleaseState(repository);
  if (!release) {
    if (manifestPath) fail('--manifest 必须与 --release 一起使用。');
    return sourceState;
  }
  if (!manifestPath) fail('正式门禁需要 --release --manifest <发行清单.json>；缺少签名 / 公证 / 实机验收证据不能放行。');
  const manifest = readJSON(resolve(manifestPath));
  const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const report = validateReleaseBundle(manifest, { directory: dirname(resolve(manifestPath)), sourceState,
    sourceCommit: git(['rev-parse', 'HEAD']), tagCommit: git(['rev-parse', `refs/tags/v${manifest.version}^{commit}`]),
    gitClean: !git(['status', '--porcelain', '--untracked-files=normal']) });
  return { ...report, github: verifyGithubRelease(sourceState, manifest) };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2); let release = false, manifestPath;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--release' && !release) release = true;
      else if (argv[index] === '--manifest' && !manifestPath && argv[index + 1]) manifestPath = argv[++index];
      else fail('用法：node tools/check-product-release.mjs [--release --manifest <清单.json>]');
    }
    console.log(JSON.stringify(checkProductRelease({ release, manifestPath }), null, 2));
  } catch (error) { console.error(`发行门禁未通过：${error.message}`); process.exitCode = 1; }
}
