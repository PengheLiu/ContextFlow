// Opt-in acceptance against the INSTALLED desktop, not a substituted native
// transport. An operator must handle the real macOS approval dialogs and revoke
// ONLY the browser row identified below. Never run this in an unattended suite.
//
// This test does not stop/install the desktop, edit personal Chrome settings,
// inspect user config/pairing files, call a model, or write/sync any notes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CONTEXTFLOW_NATIVE_LIVE !== '1') {
  console.log('SKIP real native acceptance: set CONTEXTFLOW_NATIVE_LIVE=1 only after permission to create/revoke one test-browser authorization.');
  process.exit(0);
}
assert.equal(process.platform, 'darwin', 'This opt-in acceptance currently covers macOS only.');
const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
assert.ok(runtime, 'Set CONTEXTFLOW_PLAYWRIGHT_DIR to an existing Playwright runtime.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const zip = join(root, 'release/contextflow-chrome-1.1.0.zip');
const version = '1.1.0';
const expectedZipHash = 'f3efcada584616b7c2f061664007492585a864a71e2f426a2c7d4f0bfd95c3a2';
const extensionId = 'aemncphfnlpbhlddifhohpgegejjejfm';
const hostName = 'io.github.pengheliu.contextflow';
const base = 'http://127.0.0.1:7317';
const instanceId = `CF-E2E01-${randomUUID()}`;
const label = 'Chrome · CF-E2E01';
const grantOnly = process.env.CONTEXTFLOW_NATIVE_PHASE === 'allow';
assert.ok(!process.env.CONTEXTFLOW_NATIVE_PHASE || grantOnly, 'Only an explicitly recorded allow-phase continuation is supported.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const installedManifest = join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${hostName}.json`);
const temporary = mkdtempSync(join(tmpdir(), 'cf-native-live-'));
const extension = join(temporary, 'extension'), profile = join(temporary, 'profile');
let context, page, currentStage = 'preflight', mayHaveGrant = false, completed = false, closing = false;
let pageErrorCount = 0, blockedMutationCount = 0, blockedPrivateReadCount = 0;
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const phase = (name, instruction) => {
  currentStage = name;
  console.log(`\nNATIVE_LIVE_PHASE ${name} ${new Date().toISOString()}`);
  console.log(instruction);
};
const send = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (closing) throw new Error('Operator interrupted the acceptance.');
    if (await check()) return;
    await sleep(750);
  }
  throw new Error(failure);
}
async function credentialPresent() {
  return page.evaluate(async () => !!(await chrome.storage.local.get('connection')).connection?.token);
}
async function rejectedWithoutCredential() {
  // This is a real, read-only unauthenticated request. Do not return its body,
  // service metadata, config, or a credential to the terminal.
  const response = await fetch(`${base}/health`, { headers: { 'X-ContextFlow': '1',
    'X-ContextFlow-Extension': extensionId, 'X-ContextFlow-Instance': instanceId,
    Authorization: 'Bearer native-live-deliberately-invalid' }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(response.status, 401, 'The live desktop must reject an untrusted browser credential.');
  await response.body?.cancel();
}
async function ownHealth() {
  return page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'cf-fetch', path: '/health', init: { method: 'GET' } });
    return { status: response?.status, ok: response?.body?.ok === true,
      paired: response?.body?.extensionPaired === true, managed: response?.body?.desktopManaged === true,
      version: response?.body?.serviceVersion, protocolVersion: response?.body?.protocolVersion };
  });
}
async function connected() {
  await page.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor({ timeout: 95000 });
  await page.locator('#service-version').filter({ hasText: version }).waitFor({ state: 'attached', timeout: 30000 });
  const health = await ownHealth();
  assert.deepEqual(health, { status: 200, ok: true, paired: true, managed: true, version, protocolVersion: 1 },
    'The unchanged worker must authenticate to the installed 1.1 desktop service.');
  assert.equal(await credentialPresent(), true, 'A successful native grant must persist in this temporary profile.');
  const status = await send({ type: 'cf-status' });
  assert.equal(status.ok, true); assert.equal(status.value.source, 'desktop'); assert.equal(status.value.paired, true);
  assert.equal(await page.locator('#pair-token').inputValue(), '', 'Native authorization must not fill the compatibility token field.');
  const privateStorage = await page.evaluate(async () => {
    const saved = await chrome.storage.local.get(['connection', 'desktopInstanceId']);
    const token = saved.connection?.token;
    return { sameInstance: saved.desktopInstanceId === saved.connection?.instanceId,
      id: saved.desktopInstanceId, credentialLength: token?.length,
      visibleLeak: !!token && document.documentElement.outerHTML.includes(token),
      inputLeak: !!token && [...document.querySelectorAll('input,textarea')].some(input => input.value.includes(token)) };
  });
  assert.equal(privateStorage.id, instanceId); assert.equal(privateStorage.sameInstance, true);
  assert.equal(privateStorage.credentialLength, 43); assert.equal(privateStorage.visibleLeak, false); assert.equal(privateStorage.inputLeak, false);
}
async function startConnection() {
  await page.locator('#desktop-consent').check();
  await poll(() => page.locator('#connect-desktop').isEnabled(), 10000, 'Connect button did not become available.');
  // Always use the shipped UI. In particular, never replace connectNative or
  // call the desktop bridge ourselves, and never inject a pairing token.
  await page.locator('#connect-desktop').click();
}
async function expectedRefusal(name, message, pattern, minimumMs = 0) {
  phase(name, message);
  const started = Date.now(); await startConnection();
  const refusal = page.locator('#desktop-status[data-error="true"]');
  await refusal.waitFor({ state: 'visible', timeout: 95000 });
  assert.match(await refusal.innerText(), pattern, 'The live native refusal must have the expected reason.');
  assert.ok(Date.now() - started >= minimumMs, 'The real desktop approval deadline must be exercised, not a missing-host error.');
  assert.equal(await credentialPresent(), false, 'A refused/expired dialog must not save a browser credential.');
  assert.equal((await send({ type: 'cf-status' })).value.paired, false);
  assert.equal((await send({ type: 'cf-fetch', path: '/health', init: { method: 'GET' } })).status, 428);
  await rejectedWithoutCredential();
  console.log(`PASS ${name}: client remains unpaired; live API rejects unauthenticated access.`);
  console.log(`MANUAL_CHECK ${name}: in desktop browser authorizations there must be no active row named ${label}.`);
}
async function waitForOwnRevocation(name, instruction) {
  phase(name, instruction);
  await poll(async () => {
    const status = await send({ type: 'cf-check' });
    return status.ok === true && status.value.state === 'unauthorized';
  }, 180000, 'The operator did not revoke this test instance before the deadline.');
  const health = await ownHealth(); assert.equal(health.status, 401, 'The original persisted browser credential must fail after revocation.');
  await page.locator('#check-connection').click();
  await page.locator('#connection-state').filter({ hasText: '授权已失效或被撤销' }).waitFor({ timeout: 15000 });
  mayHaveGrant = false;
  console.log(`PASS ${name}: the existing credential is rejected by the real service and the shipped UI shows revocation.`);
}
const interrupt = () => { closing = true; context?.close().catch(() => {}); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  assert.equal(sha(readFileSync(zip)), expectedZipHash, 'This test only accepts the frozen, uploaded 1.1.0 ZIP.');
  assert.equal(readFileSync(`${zip}.sha256`, 'utf8').trim().split(/\s+/)[0], expectedZipHash);
  const rawManifest = readFileSync(installedManifest), native = JSON.parse(rawManifest);
  assert.equal(native.name, hostName); assert.equal(native.type, 'stdio');
  assert.deepEqual(native.allowed_origins, [`chrome-extension://${extensionId}/`], 'Install/open the final direct desktop before this acceptance.');
  assert.ok(isAbsolute(native.path) && existsSync(native.path) && statSync(native.path).isFile(), 'The registered native host executable must exist.');
  const contents = dirname(dirname(native.path));
  const metadata = JSON.parse(readFileSync(join(contents, 'Resources/desktop-build.json'), 'utf8'));
  assert.equal(metadata.channel, 'direct'); assert.equal(metadata.platform, 'darwin'); assert.equal(metadata.arch, process.arch);
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(contents, 'Info.plist')], { encoding: 'utf8' }).trim(), version);
  const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.every(name => !name.startsWith('/') && !name.split('/').includes('..')), 'Unsafe ZIP path.');
  mkdirSync(extension); mkdirSync(profile);
  execFileSync('unzip', ['-q', zip, '-d', extension]);
  const sourceHashes = Object.fromEntries(files(extension).map(file => [relative(extension, file), sha(readFileSync(file))]));
  const manifestFile = join(extension, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.version, version); assert.ok(manifest.permissions.includes('nativeMessaging'));
  manifest.key = readFileSync(join(root, 'store/extension-key.pub'), 'utf8').trim();
  writeFileSync(manifestFile, JSON.stringify(manifest)); // Public identity only, temporary unpacked copy.
  mkdirSync(join(profile, 'NativeMessagingHosts'));
  writeFileSync(join(profile, 'NativeMessagingHosts', `${hostName}.json`), rawManifest, { mode: 0o600 });
  phase('ready', `Real native transport; temporary browser label: ${label}. Installation identifier: ${instanceId}.\nDo not revoke any other browser. No model tests, notes writes, sync, or configuration saves will be performed.\nIf cold-start acceptance is required, the operator must have normally quit the installed desktop after its first registration before this phase.`);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined,
    headless: process.env.CONTEXTFLOW_NATIVE_HEADLESS === '1', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(15000);
  // The shipped options page normally reads configuration after pairing. This
  // narrowly scoped native acceptance must not read personal configuration or
  // notes: only its authentic GET /health is allowed. Refusal is NOT a mock
  // response; the UI may show a configuration-read warning during this test.
  // Native Messaging and the desktop's own local requests are not intercepted.
  await context.route(`${base}/**`, async route => {
    if (route.request().method() !== 'GET') { blockedMutationCount++; await route.abort('blockedbyclient'); }
    else if (new URL(route.request().url()).pathname !== '/health') { blockedPrivateReadCount++; await route.abort('blockedbyclient'); }
    else await route.continue();
  });
  const worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'))
    || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith('chrome-extension://'), timeout: 20000 });
  assert.equal(new URL(worker.url()).hostname, extensionId, 'The public key must preserve the official extension identity.');
  page = await context.newPage(); page.on('pageerror', () => { pageErrorCount++; });
  await page.goto(`chrome-extension://${extensionId}/options.html#connect`);
  await page.locator('#connection-state').filter({ hasText: '尚未连接' }).waitFor();
  // This is the temporary browser's non-secret installation identity only.
  // Setting it makes the actual, unchanged worker generate an identifiable row.
  await page.evaluate(instanceId => chrome.storage.local.set({ desktopInstanceId: instanceId }), instanceId);
  assert.equal(await credentialPresent(), false);
  if (grantOnly) console.log('CONTINUATION: cancel and deadline are NOT retested in this invocation; retain their separate actual acceptance evidence.');
  else {
    await expectedRefusal('cancel', `In the REAL desktop dialog for ${label}, click “取消”. Do not click “允许连接”.`, /已取消连接/);
    await expectedRefusal('timeout', `Leave the REAL desktop dialog for ${label} untouched for 65 seconds. Do not approve or cancel it.`, /连接申请已超时|连接授权已超时|授权.*超时/, 63000);
  }
  phase('allow', `In the REAL desktop dialog for ${label}, click “允许连接”. This grants only this temporary browser instance.`);
  mayHaveGrant = true; await startConnection(); await connected();
  console.log('PASS allow: real connectNative, native executable, dialog approval and live 1.1.0 authenticated health.');
  phase('reload', 'Checking this temporary browser’s stored authorization after a settings-page reload.');
  await page.reload(); await connected();
  console.log('PASS reload: authorization and the original installation identity survive reload.');
  await waitForOwnRevocation('revoke', `In desktop Settings & Help → Browser authorizations, revoke ONLY ${label} (installation prefix CF-E2E01). Leave all other rows untouched.`);
  phase('reconnect', `Reconnecting the same temporary instance. In its REAL desktop dialog click “允许连接” again.`);
  mayHaveGrant = true; await startConnection(); await connected();
  console.log('PASS reconnect: the same instance can be explicitly authorized again after revocation.');
  await waitForOwnRevocation('cleanup', `Final cleanup: revoke ONLY ${label} again in desktop browser authorizations. This test will not remove any other grant or change the service.`);
  await page.locator('#disconnect').click();
  await page.locator('#connection-state').filter({ hasText: '尚未连接' }).waitFor();
  assert.equal(await credentialPresent(), false);
  assert.equal(pageErrorCount, 0, 'The live settings page must not emit an uncaught script error.');
  assert.equal(blockedMutationCount, 0, 'Acceptance must not attempt to save configuration, call AI, or sync notes.');
  assert.ok(blockedPrivateReadCount > 0, 'The privacy guard must actually intercept the shipped page’s automatic configuration read.');
  assert.equal(sha(readFileSync(installedManifest)), sha(rawManifest), 'Personal native-host registration content must remain unchanged.');
  for (const [name, hash] of Object.entries(sourceHashes)) if (name !== 'manifest.json') {
    assert.equal(sha(readFileSync(join(extension, name))), hash, 'No submitted executable source may change in this acceptance.');
  }
  assert.equal(sha(readFileSync(zip)), expectedZipHash, 'The frozen release ZIP must remain unchanged.');
  completed = true;
  phase('complete', `PASS real native acceptance: ${grantOnly ? '' : 'cancel, real 65s deadline, '}approval, live 1.1 health, reload, scoped GUI revocation, reconnect, and final scoped revocation. ZIP SHA256 ${expectedZipHash}.\nEvidence boundary: browser service access allowed only real GET /health; automatic personal-configuration reads were denied, so configuration UX is not assessed here. Cancelled/expired server-row absence requires the operator’s desktop-list check printed above; Gatekeeper on a clean download, Windows, Intel Mac, paid AI calls and real-note sync are not covered.`);
} catch (error) {
  // Never print Playwright DOM dumps, response bodies, config values, URLs, or
  // unsanitized browser errors from a live personal service.
  console.error(`FAIL real native acceptance at phase ${currentStage} (${error?.name || 'Error'}). No success claim.`);
  // Only this shipped connection-status label is diagnostic output. Never dump
  // the DOM, storage, configuration, or a raw Playwright assertion response.
  const status = await page?.locator('#desktop-status').innerText().catch(() => '');
  if (status) console.error(`NATIVE_STATUS ${status.replaceAll(homedir(), '[home]').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 350)}`);
  console.error(`Check the current native dialog and revoke ONLY ${label}, installation identifier ${instanceId}, if present.`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  if (mayHaveGrant && !completed) console.error(`CLEANUP REQUIRED: verify/revoke only the temporary ${label} row in the desktop UI.`);
  await context?.close().catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
