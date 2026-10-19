// First-use acceptance: run the command copied from the actual store-build page
// against the unpacked companion ZIP, never the developer's installed service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { packageStoreSupport } from '../tools/package-store-support.mjs';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to a Playwright runtime');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))('playwright');
const root = resolve(new URL('..', import.meta.url).pathname);
const temporary = mkdtempSync(join(tmpdir(), 'contextflow-first-use-'));
const config = join(temporary, 'config');
const companion = join(temporary, 'companion with spaces');
const extension = join(temporary, 'extension');
const screenshots = join(root, 'release/store-assets');
mkdirSync(config);
mkdirSync(screenshots, { recursive: true });
const reserve = createServer();
await new Promise((ready) => reserve.listen(0, '127.0.0.1', ready));
const port = reserve.address().port;
await new Promise((done) => reserve.close(done));
const base = `http://127.0.0.1:${port}`;
writeFileSync(join(config, 'config.json'), JSON.stringify({ port, requireToken: true, token: 'first-use-isolated', allowedOrigins: [] }));
const environment = { ...process.env, CONTEXTFLOW_DIR: config, ANTHROPIC_API_KEY: '', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' };
let service;
let context;
let fixture;
let options;
let article;
let output = '';
let modelCalls = 0;
const stopService = async () => {
  if (service && service.exitCode === null) {
    const exited = once(service, 'exit');
    process.kill(-service.pid, 'SIGTERM'); // Only this test's detached process group.
    await exited;
  }
};
const start = (command) => {
  service = spawn('/bin/sh', ['-c', command], { cwd: companion, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', (chunk) => { output += chunk; });
  service.stderr.on('data', (chunk) => { output += chunk; });
};
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (service.exitCode !== null) throw new Error(`Companion exited: ${output.slice(-1500)}`);
    try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }); return; } catch { /* boot or install in progress */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Companion did not start: ${output.slice(-1500)}`);
};

try {
  const artifacts = packageStoreSupport(join(temporary, 'packages'));
  execFileSync('unzip', ['-q', artifacts[0].path, '-d', companion]);
  execFileSync(process.execPath, ['tools/build.mjs', '--ext', '--store'], { cwd: root, env: { ...environment, CONTEXTFLOW_EXT_DIR: extension }, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
  manifest.key = readFileSync(join(root, 'store/extension-key.pub'), 'utf8').trim();
  manifest.host_permissions = [`${base}/*`];
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(extension, 'sw.js'), readFileSync(join(extension, 'sw.js'), 'utf8').replaceAll('http://127.0.0.1:7317', base));
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium', executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH,
    headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  assert.equal(id, 'aemncphfnlpbhlddifhohpgegejjejfm');
  options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html#connect`);
  await options.locator('#connection-state').filter({ hasText: '尚未连接' }).waitFor();
  assert.ok((await options.locator('#download-companion').getAttribute('href')).includes(`/v${manifest.version}/contextflow-companion-${manifest.version}.zip`));
  await options.evaluate(() => { navigator.clipboard.writeText = async (text) => { window.setupClipboard = text; }; });
  await options.getByRole('button', { name: '复制启动服务命令', exact: true }).click();
  const command = await options.evaluate(() => window.setupClipboard);
  assert.ok(command.includes(`npm run pair -- ${id} && npm run server`));
  await options.locator('#pair-token').fill('a'.repeat(43));
  await options.locator('#consent').check();
  await options.getByRole('button', { name: '验证并连接', exact: true }).click();
  await options.locator('#status[data-error=true]').filter({ hasText: '服务没有响应' }).waitFor();
  assert.equal(await options.locator('#pair-token').inputValue(), 'a'.repeat(43), '服务未启动时应保留配对码以便重试');
  start(command);
  await waitForHealth();
  const token = output.split('\n').find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
  assert.ok(token, '实际复制命令必须生成配对码，不依赖开发者运行额外命令');
  await options.locator('#pair-token').evaluate((input, value) => {
    const data = new DataTransfer(); data.setData('text/plain', `  ${value}\n`);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, token);
  assert.equal(await options.locator('#pair-token').inputValue(), token, '粘贴时允许首尾空白，不得截断配对码');
  await options.getByRole('button', { name: '验证并连接', exact: true }).click();
  await options.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor();
  await options.locator('#configuration #s-apiKey').waitFor();
  assert.equal(await options.locator('#pair-token').inputValue(), '');
  assert.equal(await options.locator('#first-setup').isVisible(), false);
  assert.equal(await options.locator('#configuration #s-translateAdvanced').getAttribute('open'), '');
  assert.equal(await options.locator('#configuration #s-chapter-scope').isVisible(), false);
  console.log('ok 全新 companion ZIP：实际复制命令完成依赖安装、配对生成和启动；失败重试、空白粘贴及同页配置通过');

  fixture = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'onboarding-test-model' }] }));
    }
    if (request.url === '/v1/chat/completions') {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      if (request.headers.authorization !== 'Bearer onboarding-test-only') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'Invalid test API key' } }));
      }
      modelCalls++;
      assert.ok(body.max_tokens <= 128);
      assert.equal(JSON.stringify(body).includes('阅读的价值'), false, '连接测试不得发送真实文章');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: {} }));
    }
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end(readFileSync(join(root, 'store/demo.html'), 'utf8').replace('</article>', `<p>${'这是用于验证首次使用的原创样文。'.repeat(100)}</p></article>`));
  });
  await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  article = await context.newPage();
  await article.goto(fixtureBase + '/article');
  await article.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await article.getByRole('tab', { name: '总结', exact: true }).click();
  await article.getByRole('button', { name: '配置 AI', exact: true }).waitFor();
  assert.equal(modelCalls, 0, '已连接但模型未配置时，打开文章不应触发失败或计费请求');
  await options.locator('#configuration #s-mdDir').fill(join(temporary, 'notes output'));
  await options.locator('#configuration #s-save').click();
  await options.locator('#configuration #s-msg').filter({ hasText: '已保存' }).waitFor();
  await article.locator('#selection').evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await article.getByRole('button', { name: '批注', exact: true }).click();
  await article.locator('[data-contextflow="tip-comment"] textarea').fill('首次安装后的笔记同步验收');
  await article.getByRole('button', { name: '完成', exact: true }).click();
  await article.getByRole('button', { name: '同步到笔记', exact: true }).click();
  await article.waitForFunction(() => document.querySelector('[data-contextflow="panel"]').shadowRoot.getElementById('syncmsg')?.textContent.includes('篇'));
  const notesDir = join(temporary, 'notes output/阅读记录');
  const notes = readdirSync(notesDir).filter((file) => file.endsWith('.md'));
  assert.ok(notes.some((file) => readFileSync(join(notesDir, file), 'utf8').includes('首次安装后的笔记同步验收')));
  console.log('ok 未配置 AI 也能完成真实批注 → 同步 → 目标 Markdown 文件核对');

  await options.locator('#configuration #s-baseUrl').fill(fixtureBase);
  await options.locator('#configuration #s-apiKey').fill('wrong-test-key');
  await options.locator('#configuration #s-model').fill('onboarding-test-model');
  await options.locator('#configuration #s-testModel').click();
  await options.locator('#configuration #s-modelStatus[role=alert]').filter({ hasText: '401' }).waitFor();
  assert.equal(modelCalls, 0, '无效密钥应给出明确错误，不假报成功');
  await options.locator('#configuration #s-apiKey').fill('onboarding-test-only');
  await options.locator('#configuration #s-fetchModels').click();
  await options.locator('#configuration #s-model').filter({ visible: true }).waitFor();
  await options.waitForFunction(() => document.getElementById('configuration').shadowRoot.getElementById('s-model').value === 'onboarding-test-model');
  await options.locator('#configuration #s-testModel').click();
  await options.locator('#configuration #s-msg').filter({ hasText: '模型连接成功' }).waitFor();
  assert.equal(modelCalls, 1);
  assert.equal(await options.locator('#configuration #s-apiKey').inputValue(), '');
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await options.locator('#next-step').scrollIntoViewIfNeeded();
  await options.screenshot({ path: join(screenshots, 'onboarding-configured-390x844.png') });
  await options.setViewportSize({ width: 1280, height: 900 });
  await options.locator('#next-step').scrollIntoViewIfNeeded();
  await options.screenshot({ path: join(screenshots, 'onboarding-configured-1280x900.png') });
  console.log('ok 同页保存模型、获取模型、主动测试和私钥不回显；只调用隔离模拟模型，无真实费用');

  await options.reload();
  await options.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor();
  await options.locator('#configuration #s-model').waitFor();
  assert.equal(await options.locator('#configuration #s-model').inputValue(), 'onboarding-test-model');
  await stopService();
  await options.locator('#check-connection').click();
  await options.locator('#restart-help').waitFor();
  const restart = await options.locator('#restart-command').textContent();
  assert.ok(!restart.includes('run pair'));
  start(restart);
  await waitForHealth();
  await options.locator('#check-connection').click();
  await options.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor();
  assert.equal(modelCalls, 1, '重启和连接检查不能自动调用模型');
  console.log('ok 重新打开恢复已保存配置，停止/重启服务保持原配对，不重新安装、不重复计费');
} catch (error) {
  if (options) await options.screenshot({ path: join(screenshots, 'first-use-failure-options.png') });
  if (article) {
    await article.screenshot({ path: join(screenshots, 'first-use-failure-article.png') });
    console.error(await article.locator('[data-contextflow="panel"]').innerText());
  }
  throw error;
} finally {
  if (context) await context.close();
  await stopService();
  if (fixture) await new Promise((done) => fixture.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
