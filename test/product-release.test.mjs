import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sourceReleaseState, validateReleaseBundle, checkProductRelease, verifyGithubRelease, checkUnsignedDesktopFiles, RELEASE_TARGETS, EVIDENCE_BOUNDARY } from '../tools/check-product-release.mjs';

const sourceCommit = 'a'.repeat(40), oldCommit = 'b'.repeat(40), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const publicState = () => ({ schemaVersion: 1, candidateVersion: '1.1.0', channel: 'preview',
  publishedExtension: { version: '1.0.0', status: 'published', checkedAt: '2026-10-23', storeId: 'aemncphfnlpbhlddifhohpgegejjejfm' },
  publishedGithub: { version: '1.0.0', tag: 'v1.0.0', commit: oldCommit, checkedAt: '2026-10-23' },
  desktop: { updateMode: 'manual', platforms: Object.fromEntries(RELEASE_TARGETS.map(target => [target,
    { status: 'unpublished', validation: target === 'darwin-arm64' ? 'local-preview-verified' : 'not-verified' }])) } });
const unsignedState = (version = '1.1.0') => {
  const state = publicState(), url = `https://github.com/PengheLiu/ContextFlow/releases/download/v${version}/ContextFlow-${version}-mac-arm64.dmg`;
  state.candidateVersion = version;
  state.desktop.platforms['darwin-arm64'] = { status: 'available-unsigned', validation: 'local-package-verified', version,
    releaseTag: `v${version}`, artifact: `ContextFlow-${version}-mac-arm64.dmg`, sha256: digest('unsigned fixture bytes'),
    checkedAt: '2026-10-23', signing: 'unsigned-unnotarized', downloadUrl: url, checksumUrl: `${url}.sha256` };
  return state;
};
const putJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
function sourceFixture(version = '1.1.0') {
  const root = mkdtempSync(join(tmpdir(), 'contextflow-product-release-'));
  mkdirSync(join(root, 'product')); mkdirSync(join(root, 'desktop'));
  const state = publicState(); state.candidateVersion = version;
  putJSON(join(root, 'product/release.json'), state);
  for (const prefix of ['', 'desktop/']) {
    putJSON(join(root, `${prefix}package.json`), { version });
    putJSON(join(root, `${prefix}package-lock.json`), { version, packages: { '': { version } } });
  }
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}
function bundleFixture({ mode = 'manual', targets = ['darwin-arm64'] } = {}) {
  const sample = sourceFixture(), directory = join(sample.root, 'artifacts'); mkdirSync(directory);
  const state = publicState(); state.candidateVersion = '1.2.0'; state.channel = 'release'; state.desktop.updateMode = mode;
  const manifest = { schemaVersion: 1, version: '1.2.0', channel: 'release', updateMode: mode, sourceCommit, tag: 'v1.2.0', targets: [], artifacts: [] };
  function add(name, value, target) {
    const bytes = Buffer.from(value); writeFileSync(join(directory, name), bytes);
    const row = { name, size: bytes.length, sha256: digest(bytes), ...(target ? { target } : {}) };
    manifest.artifacts.push(row); return row;
  }
  const name = (target, ext) => `ContextFlow-1.2.0-${target.replace('darwin', 'mac').replace('win32', 'win')}.${ext}`;
  for (const target of targets) {
    for (const ext of target.startsWith('darwin') ? mode === 'auto' ? ['dmg', 'zip'] : ['dmg'] : ['exe']) {
      const row = add(name(target, ext), `isolated ${target} ${ext} artifact bytes`, target);
      writeFileSync(join(directory, `${row.name}.sha256`), `${row.sha256}  ${row.name}\n`);
      if (mode === 'auto') add(`${row.name}.blockmap`, `isolated blockmap ${row.name}`, target);
    }
  }
  if (mode === 'auto') for (const [prefix, filename] of [['darwin', 'latest-mac.yml'], ['win32', 'latest.yml']]) {
    const installers = manifest.artifacts.filter(row => row.target?.startsWith(prefix) && /\.(?:dmg|zip|exe)$/.test(row.name));
    if (!installers.length) continue;
    add(filename, JSON.stringify({ version: '1.2.0', files: installers.map(row => ({ url: row.name, size: row.size,
      sha512: createHash('sha512').update(readFileSync(join(directory, row.name))).digest('base64') })) }));
  }
  function evidence(target) {
    const platform = target.split('-')[0], own = manifest.artifacts.filter(row => row.target === target && /\.(?:dmg|zip|exe)$/.test(row.name));
    const command = (id, name, args, result) => ({ id, method: 'command', command: name, args, exitCode: 0,
      output: 'isolated command evidence, not a real signature', outputSha256: digest('isolated command evidence, not a real signature'),
      observation: 'Only a test fixture; never promote this to platform validation.', ...(result ? { result } : {}) });
    return { format: 'ContextFlowDesktopReleaseEvidence', schemaVersion: 1, target, version: '1.2.0', sourceCommit, updateMode: mode,
      observedAt: '2026-10-23T12:00:00Z', environment: { platform, arch: target.split('-')[1], osVersion: 'fixture-OS' },
      artifacts: Object.fromEntries(own.map(row => [row.name, row.sha256])),
      updatePublisherNames: platform === 'win32' ? ['CN=Fixture publisher, O=Fixture only'] : undefined,
      checks: [
        ...(platform === 'darwin' ? [command('mac-signature', 'codesign', ['--verify', '--strict', 'fixture.app']),
          command('mac-notarization', 'xcrun', ['notarytool', 'info', 'fixture-request'], 'Accepted'),
          command('mac-staple', 'xcrun', ['stapler', 'validate', 'fixture.app']), command('mac-gatekeeper', 'spctl', ['--assess', 'fixture.app'])]
          : [command('windows-signature', 'signtool', ['verify', '/pa', 'fixture.exe'])]),
        ...['clean-install', 'browser-connect', 'reading-and-sync', 'close-reopen', 'sleep-resume', 'uninstall-preserves-data',
          ...(mode === 'auto' ? ['signed-upgrade', 'failed-update-recovery'] : ['manual-overwrite-preserves-data'])].map(id => ({ id,
          method: 'manual', outcome: 'passed', reviewer: 'test fixture, not an actual reviewer', steps: ['Perform the documented operation in an isolated fixture.'],
          observation: 'Fixture observation with explicit actions; not evidence of real device testing.' })),
      ] };
  }
  for (const target of targets) {
    const report = evidence(target), reportName = `${target}.evidence.json`; putJSON(join(directory, reportName), report);
    manifest.targets.push({ target, evidence: { name: reportName, sha256: digest(readFileSync(join(directory, reportName))) } });
  }
  const options = { directory, sourceState: state, sourceCommit, tagCommit: sourceCommit, gitClean: true, parseYAML: JSON.parse };
  const validate = () => validateReleaseBundle(manifest, options);
  function editEvidence(target, edit) {
    const row = manifest.targets.find(row => row.target === target), file = join(directory, row.evidence.name);
    const report = JSON.parse(readFileSync(file)); edit(report); putJSON(file, report); row.evidence.sha256 = digest(readFileSync(file));
  }
  function editMetadata(name, edit) {
    const file = join(directory, name), value = JSON.parse(readFileSync(file)); edit(value); putJSON(file, value);
    const row = manifest.artifacts.find(row => row.name === name), bytes = readFileSync(file); row.size = bytes.length; row.sha256 = digest(bytes);
  }
  return { ...sample, directory, manifest, options, validate, editEvidence, editMetadata, name };
}

test('offline status separates candidate, published extension/GitHub and four unlaunched desktop targets', () => {
  const f = sourceFixture();
  try {
    const state = sourceReleaseState(f.root);
    assert.equal(state.candidateVersion, '1.1.0'); assert.equal(state.publishedExtension.version, '1.0.0');
    assert.equal(state.desktop.updateMode, 'manual'); assert.equal(state.releaseReady, false);
    assert.equal(state.desktop.platforms['darwin-arm64'].validation, 'local-preview-verified');
    assert.ok(Object.values(state.desktop.platforms).every(row => row.status === 'unpublished'));
    assert.equal(state.evidenceBoundary, EVIDENCE_BOUNDARY); assert.match(state.notes.join(' '), /离线检查不冒充实时/);
    assert.deepEqual(checkProductRelease({ repository: f.root }), state);
    assert.throws(() => checkProductRelease({ repository: f.root, release: true }), /需要 --release --manifest/);
  } finally { f.close(); }
});

test('all six source/package/lock versions must match the public candidate record', () => {
  for (const [file, edit] of [['package.json', value => value.version = '1.0.0'], ['package-lock.json', value => value.version = '1.0.0'],
    ['package-lock.json', value => value.packages[''].version = '1.0.0'], ['desktop/package.json', value => value.version = '1.0.0'],
    ['desktop/package-lock.json', value => value.version = '1.0.0'], ['desktop/package-lock.json', value => value.packages[''].version = '1.0.0']]) {
    const f = sourceFixture();
    try { const value = JSON.parse(readFileSync(join(f.root, file))); edit(value); putJSON(join(f.root, file), value); assert.throws(() => sourceReleaseState(f.root), /版本不一致/); }
    finally { f.close(); }
  }
});

test('unsigned Mac ARM availability is explicit and never promotes the published stable baseline or formal release gate', () => {
  const f = sourceFixture();
  try {
    putJSON(join(f.root, 'product/release.json'), unsignedState());
    const state = sourceReleaseState(f.root), row = state.desktop.platforms['darwin-arm64'];
    assert.equal(row.status, 'available-unsigned'); assert.equal(row.signing, 'unsigned-unnotarized');
    assert.equal(state.releaseReady, false); assert.equal(state.publishedGithub.version, '1.0.0'); assert.equal(state.publishedGithub.tag, 'v1.0.0');
    assert.ok(RELEASE_TARGETS.filter(target => target !== 'darwin-arm64').every(target => state.desktop.platforms[target].status === 'unpublished'));
    const bundle = bundleFixture();
    try {
      bundle.options.sourceState = state; assert.throws(bundle.validate, /preview/);
      bundle.options.sourceState.channel = 'release'; bundle.options.sourceState.candidateVersion = '1.2.0';
      bundle.editEvidence('darwin-arm64', report => report.checks = report.checks.filter(check => check.id !== 'mac-notarization'));
      assert.throws(bundle.validate, /mac-notarization/, '可下载的未签名包不得绕过正式公证要求');
      bundle.manifest.tag = row.releaseTag; assert.throws(bundle.validate, /tag/);
    } finally { bundle.close(); }
  } finally { f.close(); }
});

test('unsigned download binding rejects other architectures, altered URLs/tags, absent hashes and false signing claims', () => {
  for (const mutate of [state => state.desktop.platforms['win32-x64'] = { ...state.desktop.platforms['darwin-arm64'] },
    state => state.desktop.platforms['darwin-arm64'].releaseTag = 'v1.1.1', state => state.desktop.platforms['darwin-arm64'].artifact = 'ContextFlow-1.1.0-mac-x64.dmg',
    state => state.desktop.platforms['darwin-arm64'].downloadUrl = 'https://other.example/package.dmg',
    state => state.desktop.platforms['darwin-arm64'].checksumUrl += '?from=unverified', state => delete state.desktop.platforms['darwin-arm64'].sha256,
    state => state.desktop.platforms['darwin-arm64'].checkedAt = 'unknown', state => state.desktop.platforms['darwin-arm64'].validation = 'release-verified',
    state => state.desktop.platforms['darwin-arm64'].signing = 'signed', state => state.desktop.platforms['darwin-arm64'].signed = true,
    state => state.desktop.updateMode = 'auto']) {
    const f = sourceFixture();
    try { const state = unsignedState(); mutate(state); putJSON(join(f.root, 'product/release.json'), state); assert.throws(() => sourceReleaseState(f.root)); }
    finally { f.close(); }
  }
});

test('reviewed unsigned 1.1.1 binds exact files without approving future versions or a later signing overwrite', () => {
  const f = sourceFixture('1.1.1'), state = unsignedState('1.1.1'), directory = join(f.root, 'unsigned'); mkdirSync(directory);
  const row = state.desktop.platforms['darwin-arm64'];
  try {
    putJSON(join(f.root, 'product/release.json'), state);
    assert.equal(sourceReleaseState(f.root).releaseReady, false);
    writeFileSync(join(directory, row.artifact), 'unsigned fixture bytes');
    writeFileSync(join(directory, `${row.artifact}.sha256`), `${row.sha256}  ${row.artifact}\n`);
    assert.equal(checkUnsignedDesktopFiles(directory, state).version, '1.1.1');
    putJSON(join(f.root, 'product/release.json'), unsignedState('1.1.2'));
    assert.throws(() => sourceReleaseState(f.root), /未签名下载/);
    const older = { ...state, candidateVersion: '1.1.0' };
    putJSON(join(f.root, 'product/release.json'), older);
    assert.throws(() => sourceReleaseState(f.root), /桌面下载版本/);
    const bundle = bundleFixture();
    try {
      bundle.options.sourceState.candidateVersion = '1.1.1'; bundle.manifest.version = '1.1.1'; bundle.manifest.tag = 'v1.1.1';
      assert.throws(bundle.validate, /已保留为未签名分发/);
    } finally { bundle.close(); }
  } finally { f.close(); }
});

test('authorized unsigned file checks compare actual local bytes and sidecar without running or publishing them', () => {
  const f = sourceFixture(), state = unsignedState(), directory = join(f.root, 'unsigned'); mkdirSync(directory);
  const row = state.desktop.platforms['darwin-arm64'], file = join(directory, row.artifact);
  try {
    writeFileSync(file, 'unsigned fixture bytes'); writeFileSync(`${file}.sha256`, `${row.sha256}  ${row.artifact}\n`);
    const result = checkUnsignedDesktopFiles(directory, state);
    assert.equal(result.sha256, row.sha256); assert.equal(result.releaseReady, false); assert.equal(result.signing, 'unsigned-unnotarized');
    writeFileSync(file, 'different artifact'); assert.throws(() => checkUnsignedDesktopFiles(directory, state), /实际摘要/);
    writeFileSync(file, 'unsigned fixture bytes'); writeFileSync(`${file}.sha256`, 'wrong sidecar');
    assert.throws(() => checkUnsignedDesktopFiles(directory, state), /校验侧车/);
    assert.throws(() => checkUnsignedDesktopFiles(directory, publicState()), /没有授权/);
  } finally { f.close(); }
});

test('missing, malformed or falsely promoted public-state records fail closed', () => {
  const mutations = [value => value.channel = 'stable', value => value.candidateVersion = '1.01.0', value => value.candidateVersion = '0.9.0',
    value => value.publishedExtension.storeId = 'wrong', value => value.publishedExtension.checkedAt = '2026-02-30',
    value => value.publishedGithub.commit = 'not-a-commit', value => value.desktop.updateMode = undefined,
    value => delete value.desktop.platforms['win32-arm64'], value => value.desktop.platforms['darwin-arm64'].status = 'published',
    value => value.desktop.platforms['darwin-arm64'].signed = true, value => value.desktop.platforms['darwin-arm64'].url = 'https://fake/download.dmg'];
  for (const mutate of mutations) {
    const f = sourceFixture();
    try { const state = publicState(); mutate(state); putJSON(join(f.root, 'product/release.json'), state); assert.throws(() => sourceReleaseState(f.root)); }
    finally { f.close(); }
  }
});

test('manual release validates hash-bound reports without inventing ZIP, automatic updates or real platform execution', () => {
  const f = bundleFixture();
  try {
    const result = f.validate(); assert.equal(result.checksPassed, true); assert.equal(result.updateMode, 'manual');
    assert.deepEqual(result.targets, ['darwin-arm64']); assert.equal(result.evidenceBoundary, EVIDENCE_BOUNDARY);
    assert.equal(f.manifest.artifacts.some(row => /zip|blockmap|yml/.test(row.name)), false);
  } finally { f.close(); }
});

test('manual installers may cover both Windows architectures without claiming an automatic update route', () => {
  const f = bundleFixture({ targets: ['win32-x64', 'win32-arm64'] });
  try { assert.equal(f.validate().targets.length, 2); } finally { f.close(); }
});

test('a new formal version, release channel, clean source and exact HEAD/tag binding are mandatory', () => {
  for (const change of [f => f.options.sourceState.channel = 'preview', f => f.manifest.channel = 'preview',
    f => f.manifest.version = '1.0.0', f => f.options.sourceState.publishedGithub.version = '1.2.0',
    f => f.options.sourceState.publishedExtension.version = '1.3.0', f => f.options.gitClean = false,
    f => f.options.tagCommit = oldCommit, f => f.manifest.sourceCommit = oldCommit, f => f.manifest.tag = 'v1.0.0',
    f => f.manifest.updateMode = 'auto']) {
    const f = bundleFixture(); try { change(f); assert.throws(f.validate); } finally { f.close(); }
  }
});

test('the unsigned v1.1.0 tag is reserved and cannot later be overwritten by a signed release', () => {
  const f = bundleFixture();
  try {
    f.options.sourceState.candidateVersion = '1.1.0'; f.manifest.version = '1.1.0'; f.manifest.tag = 'v1.1.0';
    assert.throws(f.validate, /已保留为未签名分发/);
  } finally { f.close(); }
});

test('actual bytes, size and checksum sidecars are checked rather than trusting artifact filenames', () => {
  for (const change of [f => writeFileSync(join(f.directory, f.name('darwin-arm64', 'dmg')), 'altered bytes'),
    f => f.manifest.artifacts[0].size++, f => f.manifest.artifacts[0].sha256 = '0'.repeat(64),
    f => writeFileSync(join(f.directory, `${f.name('darwin-arm64', 'dmg')}.sha256`), 'invalid digest')]) {
    const f = bundleFixture(); try { change(f); assert.throws(f.validate); } finally { f.close(); }
  }
});

test('stale installer globs, mismatched target formats and unknown target claims are rejected', () => {
  for (const change of [f => writeFileSync(join(f.directory, 'ContextFlow-1.0.0-mac-arm64.dmg'), 'old bytes'),
    f => f.manifest.artifacts[0].target = 'darwin-x64', f => f.manifest.targets[0].target = 'linux-x64',
    f => f.manifest.targets.push({ ...f.manifest.targets[0] }), f => f.manifest.artifacts.push({ ...f.manifest.artifacts[0] })]) {
    const f = bundleFixture(); try { change(f); assert.throws(f.validate); } finally { f.close(); }
  }
});

test('absolute paths, traversal and symbolic links cannot make the gate read outside the artifact directory', () => {
  for (const name of ['/tmp/private.dmg', '../private.dmg', 'folder\\private.dmg']) {
    const f = bundleFixture(); try { f.manifest.targets[0].evidence.name = name; assert.throws(f.validate, /顶层文件/); } finally { f.close(); }
  }
  if (process.platform !== 'win32') {
    const f = bundleFixture();
    try {
      const row = f.manifest.artifacts[0], path = join(f.directory, row.name); rmSync(path); symlinkSync(join(f.root, 'package.json'), path);
      assert.throws(f.validate, /普通文件/); assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '1.1.0');
    } finally { f.close(); }
  }
});

test('evidence files must be unchanged and bind every installer, source, platform and update mode', () => {
  for (const edit of [value => value.sourceCommit = oldCommit, value => value.target = 'darwin-x64', value => value.version = '1.0.0',
    value => value.updateMode = 'auto', value => value.environment.platform = 'win32', value => value.environment.arch = 'x64',
    value => value.artifacts = {}, value => value.observedAt = 'invalid']) {
    const f = bundleFixture(); try { f.editEvidence('darwin-arm64', edit); assert.throws(f.validate); } finally { f.close(); }
  }
  const f = bundleFixture();
  try { writeFileSync(join(f.directory, f.manifest.targets[0].evidence.name), '{}'); assert.throws(f.validate, /报告摘要变化/); } finally { f.close(); }
});

test('signed=true and tested=true do not replace command results or actual step observations', () => {
  for (const edit of [value => value.checks = [{ signed: true, tested: true }], value => value.checks[0].exitCode = 1,
    value => value.checks[0].outputSha256 = '0'.repeat(64), value => value.checks[0].args = [],
    value => value.checks.find(row => row.id === 'mac-notarization').result = 'In Progress',
    value => value.checks.find(row => row.method === 'manual').observation = 'passed',
    value => value.checks.find(row => row.method === 'manual').steps = [], value => value.checks.push({ ...value.checks[0] })]) {
    const f = bundleFixture(); try { f.editEvidence('darwin-arm64', edit); assert.throws(f.validate); } finally { f.close(); }
  }
});

test('automatic macOS releases require ZIP, blockmaps, accurate feed hashes and real upgrade/recovery receipts', () => {
  const valid = bundleFixture({ mode: 'auto', targets: ['darwin-arm64', 'darwin-x64'] });
  try { assert.equal(valid.validate().targets.length, 2); } finally { valid.close(); }
  for (const edit of [f => { const index = f.manifest.artifacts.findIndex(row => row.name.endsWith('.zip')); const [row] = f.manifest.artifacts.splice(index, 1); rmSync(join(f.directory, row.name)); },
    f => { const index = f.manifest.artifacts.findIndex(row => row.name.endsWith('.blockmap')); const [row] = f.manifest.artifacts.splice(index, 1); rmSync(join(f.directory, row.name)); },
    f => f.editMetadata('latest-mac.yml', metadata => metadata.files[0].sha512 = 'bad'),
    f => f.editMetadata('latest-mac.yml', metadata => metadata.files[0].size++),
    f => f.editMetadata('latest-mac.yml', metadata => metadata.files[0].url = 'https://other.example/update.dmg'),
    f => f.editMetadata('latest-mac.yml', metadata => metadata.version = '1.0.0'),
    f => f.editEvidence('darwin-arm64', value => value.checks = value.checks.filter(row => row.id !== 'failed-update-recovery'))]) {
    const f = bundleFixture({ mode: 'auto' }); try { edit(f); assert.throws(f.validate); } finally { f.close(); }
  }
});

test('automatic Windows updates require publisher identities and reject currently unsupported mixed-arch feeds', () => {
  const f = bundleFixture({ mode: 'auto', targets: ['win32-x64'] });
  try { assert.equal(f.validate().checksPassed, true); f.editEvidence('win32-x64', value => value.updatePublisherNames = []); assert.throws(f.validate, /发布者名称/); }
  finally { f.close(); }
  const mixed = bundleFixture({ mode: 'auto', targets: ['win32-x64', 'win32-arm64'] });
  try { assert.throws(mixed.validate, /两个 Windows 架构/); } finally { mixed.close(); }
});

test('strict remote verification resolves annotated tags and binds both frozen and new public source commits', () => {
  const calls = [], source = publicState(), manifest = { version: '1.1.0', tag: 'v1.1.0', sourceCommit };
  const values = { 'releases/latest': { tag_name: 'v1.0.0', draft: false, prerelease: false },
    'git/ref/tags/v1.0.0': { object: { type: 'tag', sha: 'c'.repeat(40) } },
    ['git/tags/' + 'c'.repeat(40)]: { object: { type: 'commit', sha: oldCommit } },
    'git/ref/tags/v1.1.0': { object: { type: 'commit', sha: sourceCommit } } };
  const result = verifyGithubRelease(source, manifest, { readAPI: route => { calls.push(route); return values[route]; } });
  assert.equal(result.repository, 'PengheLiu/ContextFlow'); assert.equal(result.sourceCommit, sourceCommit);
  assert.deepEqual(calls, ['releases/latest', 'git/ref/tags/v1.0.0', 'git/tags/' + 'c'.repeat(40), 'git/ref/tags/v1.1.0']);
  for (const mutate of [state => state['releases/latest'].tag_name = 'v1.1.0', state => state['releases/latest'].draft = true,
    state => state['git/ref/tags/v1.1.0'].object.sha = oldCommit, state => state['git/tags/' + 'c'.repeat(40)].object.sha = sourceCommit,
    state => delete state['git/ref/tags/v1.1.0']]) {
    const state = structuredClone(values); mutate(state);
    assert.throws(() => verifyGithubRelease(source, manifest, { readAPI: route => state[route] }));
  }
  const stale = publicState(); stale.publishedGithub.version = '0.9.0';
  assert.throws(() => verifyGithubRelease(stale, manifest, { readAPI: route => values[route] }), /记录已过期/);
  assert.throws(() => verifyGithubRelease(source, manifest, { readAPI: () => { throw new Error('offline'); } }), /offline/);
});

test('CLI cannot treat a missing manifest or preview as an approved release or perform mutations', () => {
  assert.throws(() => execFileSync(process.execPath, ['tools/check-product-release.mjs', '--release'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' }), /Command failed/);
  const source = readFileSync(new URL('../tools/check-product-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:writeFile|unlink|rename|mkdir|rmSync|spawn|shell\.open|quitAndInstall)/);
  assert.match(source, /git\(\['status'/); assert.match(source, /evidenceBoundary/);
});

test('default offline CLI runs from source with no desktop node_modules and without gh on PATH', () => {
  const f = sourceFixture();
  try {
    mkdirSync(join(f.root, 'tools'));
    const source = readFileSync(new URL('../tools/check-product-release.mjs', import.meta.url), 'utf8');
    writeFileSync(join(f.root, 'tools/check-product-release.mjs'), source);
    const output = execFileSync(process.execPath, [join(f.root, 'tools/check-product-release.mjs')], {
      cwd: f.root, env: { ...process.env, PATH: join(f.root, 'no-command-directory') }, encoding: 'utf8', timeout: 5000,
    });
    const result = JSON.parse(output); assert.equal(result.candidateVersion, '1.1.0'); assert.equal(result.releaseReady, false);
  } finally { f.close(); }
});
