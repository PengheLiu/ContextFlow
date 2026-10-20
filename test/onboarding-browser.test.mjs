// First-use acceptance: run the command copied from the actual store-build page
// against the unpacked companion ZIP, never the developer's installed service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { packageStoreSupport } from '../tools/package-store-support.mjs';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to a Playwright runtime');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))(process.env.CONTEXTFLOW_PLAYWRIGHT_MODULE || 'playwright');
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
// All CLI calls in this acceptance run target temporary fixtures, never a user's
// signed-in Agent. The companion still spawns and cancels a real child process.
const fakeBin=join(temporary,'fake-bin'),agentMode=join(temporary,'agent-mode'),agentRecord=join(temporary,'agent-request.json'),agentCanceled=join(temporary,'agent-canceled');
mkdirSync(fakeBin);writeFileSync(agentMode,'success');
for(const name of ['claude','codex','dsh','gemini']) writeFileSync(join(fakeBin,name),`#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fixture-agent 1.0');process.exit(0);}
(async()=>{let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const mode=fs.readFileSync(${JSON.stringify(agentMode)},'utf8');
fs.writeFileSync(${JSON.stringify(agentRecord+'.tmp')},JSON.stringify({argv:process.argv.slice(2),prompt,mode}));
fs.renameSync(${JSON.stringify(agentRecord+'.tmp')},${JSON.stringify(agentRecord)});
if(mode==='hold'){process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(agentCanceled)},'canceled');process.exit(0);});setInterval(()=>{},1000);return;}
console.log(JSON.stringify({type:'result',subtype:'success',is_error:mode==='auth',result:mode==='auth'?'Not logged in. Please run /login':'OK'}));})();
`,{mode:0o755});
environment.PATH=fakeBin+':'+process.env.PATH;
let service;
let context;
let fixture;
let options;
let article;
let output = '';
let modelCalls = 0;
let modelListMode = 'success';
let aiBehavior = 'check';
let upstreamWaiting = false, upstreamCanceled = false;
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
      if (modelListMode === 'error') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'Invalid list test API key' } }));
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ data: modelListMode === 'empty' ? [] : [{ id: 'onboarding-test-model' }, { id: 'alternate-test-model' }, { id: 'onboarding-test-model' }] }));
    }
    if (request.url === '/v1/chat/completions') {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      if (request.headers.authorization !== 'Bearer onboarding-test-only') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'Invalid test API key' } }));
      }
      modelCalls++;
      if (aiBehavior === 'check') {
        assert.ok(body.max_tokens <= 128);
        assert.equal(JSON.stringify(body).includes('阅读的价值'), false, '连接测试不得发送真实文章');
      }
      if (aiBehavior === 'hold') {
        upstreamWaiting = true;
        response.on('close', () => { upstreamCanceled = true; });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end(JSON.stringify({ choices: [{ message: { content: aiBehavior === 'check' ? 'OK' : '重新生成后的模拟答案。' }, finish_reason: 'stop' }], usage: {} }));
    }
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end(readFileSync(join(root, 'store/demo.html'), 'utf8').replace('</article>', `<p>${'这是用于验证首次使用的原创样文。'.repeat(100)}</p></article>`));
  });
  await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  article = await context.newPage();
  await article.goto(fixtureBase + '/article');
  await article.getByRole('button', { name: '展开 ContextFlow', exact: true }).click();
  await article.getByRole('tab', { name: '文章速览', exact: true }).click();
  await article.getByRole('button', { name: '配置 AI', exact: true }).waitFor();
  assert.equal(modelCalls, 0, '已连接但模型未配置时，打开文章不应触发失败或计费请求');
  await options.locator('#configuration #s-chapter-archive > summary').click();
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
  await article.locator('[data-contextflow="tip-comment"] #c').waitFor({state:'hidden'});
  await article.getByRole('button', { name: '同步到笔记', exact: true }).click();
  await article.waitForFunction(() => document.querySelector('[data-contextflow="panel"]').shadowRoot.getElementById('syncmsg')?.textContent.includes('篇'));
  const notesDir = join(temporary, 'notes output/阅读记录');
  const notes = readdirSync(notesDir).filter((file) => file.endsWith('.md'));
  assert.ok(notes.some((file) => readFileSync(join(notesDir, file), 'utf8').includes('首次安装后的笔记同步验收')));
  console.log('ok 未配置 AI 也能完成真实批注 → 同步 → 目标 Markdown 文件核对');

  // Cross-article data lives in the extension origin, not in a website or the
  // companion. Exercise real downloads and file selection in an isolated profile.
  const libraryOpened=context.waitForEvent('page');
  await article.getByRole('button',{name:'我的阅读库',exact:true}).click();
  const library=await libraryOpened;await library.waitForURL(`chrome-extension://${id}/options.html#library`);
  const libraryErrors=[];library.on('pageerror',error=>libraryErrors.push(error.message));
  const libraryRoot='#reading-library';
  await library.locator(`${libraryRoot} #library-stats`).filter({hasText:'1 篇文章'}).waitFor();
  assert.equal(await library.locator('#connect').isVisible(),false,'阅读库和首次连接向导不混在一起');
  const [mdDownload]=await Promise.all([library.waitForEvent('download'),library.getByRole('button',{name:'下载 Markdown',exact:true}).click()]);
  assert.match(readFileSync(await mdDownload.path(),'utf8'),/首次安装后的笔记同步验收/);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6BckAAAAASUVORK5CYII=';
  const imageId=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex');
  const restoredUrl=fixtureBase+'/restored-article';
  const restoreFixture=JSON.stringify({format:'contextflow-reading-backup',version:1,exportedAt:Date.now(),
    events:[{id:'restored-note',urlKey:restoredUrl,url:restoredUrl,title:'从备份找回的阅读',action:'note',value:`这是独立阅读库里的笔记 ![原文截图](contextflow-asset:${imageId})`,createdAt:Date.now(),extra:{apiKey:'must-not-be-imported'}},
      {id:'restored-pending',urlKey:restoredUrl,url:restoredUrl,title:'从备份找回的阅读',action:'explain',text:'恢复中的请求',value:null,createdAt:Date.now(),extra:{status:'running',jobId:'must-not-resume',question:'旧问题'}}],
    assets:[{id:imageId,mime:'image/png',name:'截图.png',data:png}]});
  const restoreFile={name:'reading-test.json',mimeType:'application/json',buffer:Buffer.from(restoreFixture)};
  await library.locator(`${libraryRoot} #library-file`).setInputFiles(restoreFile);
  await library.locator(`${libraryRoot} #library-restore-preview`).waitFor();
  assert.match(await library.locator(`${libraryRoot} #library-stats`).textContent(),/1 篇文章/,'文件预览不能写入');
  await library.getByRole('button',{name:'取消恢复',exact:true}).click();
  await library.locator(`${libraryRoot} #library-file`).setInputFiles(restoreFile);
  await library.getByRole('button',{name:'确认补充记录',exact:true}).click();
  await library.locator(`${libraryRoot} #library-notice`).filter({hasText:'补充 2 条'}).waitFor();
  await library.getByRole('searchbox',{name:'搜索全部文章'}).fill('独立阅读库');
  await library.locator(`${libraryRoot} #library-results`).filter({hasText:'1 / 2'}).waitFor();
  await library.locator(`${libraryRoot} #library-preview-body img`).waitFor();
  await library.waitForFunction(()=>{const img=document.getElementById('reading-library').shadowRoot.querySelector('#library-preview-body img');return img?.complete && img.naturalWidth>0;});
  await article.getByRole('tab',{name:'我的笔记',exact:true}).click();
  await article.locator('[data-contextflow="panel"] #note textarea').fill('备份之前刚输入的最后一句，也必须保存。');
  const [backupDownload]=await Promise.all([library.waitForEvent('download'),library.getByRole('button',{name:'下载完整备份',exact:true}).click()]);
  const backupText=readFileSync(await backupDownload.path(),'utf8'),backupData=JSON.parse(backupText);
  assert.equal(backupData.assets.length,1);assert.equal(backupData.assets[0].id,imageId);
  assert.ok(backupData.events.some(e=>e.value?.includes('首次安装后的笔记同步验收')));
  assert.ok(backupData.events.some(e=>e.value?.includes('备份之前刚输入的最后一句')),'跨页面备份必须等待阅读页尚未防抖提交的输入');
  assert.equal(backupData.events.find(e=>e.id==='restored-pending').extra.status,'canceled');
  assert.doesNotMatch(backupText,/must-not-be-imported|must-not-resume|first-use-isolated/);
  await library.locator(`${libraryRoot} #library-file`).setInputFiles({name:'repeat.json',mimeType:'application/json',buffer:Buffer.from(backupText)});
  await library.getByRole('button',{name:'确认补充记录',exact:true}).click();
  await library.locator(`${libraryRoot} #library-notice`).filter({hasText:'补充 0 条'}).waitFor();
  const wrong=JSON.parse(backupText);wrong.assets[0].data=btoa('damaged');
  await library.locator(`${libraryRoot} #library-file`).setInputFiles({name:'damaged.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(wrong))});
  await library.locator(`${libraryRoot} #library-notice[role=alert]`).filter({hasText:'校验失败'}).waitFor();
  assert.equal(await library.locator(`${libraryRoot} #library-restore-preview`).isVisible(),false);
  await library.getByRole('searchbox',{name:'搜索全部文章'}).fill('');
  await library.screenshot({path:join(screenshots,'reading-library-desktop.png')});
  await library.setViewportSize({width:390,height:844});
  assert.equal(await library.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await library.screenshot({path:join(screenshots,'reading-library-narrow.png')});
  await library.emulateMedia({colorScheme:'dark'});
  const darkColors=await library.evaluate(()=>({paper:getComputedStyle(document.documentElement).backgroundColor,
    text:getComputedStyle(document.getElementById('reading-library').shadowRoot.querySelector('.library')).color}));
  assert.notEqual(darkColors.paper,'rgb(252, 250, 246)');assert.notEqual(darkColors.text,darkColors.paper);
  await library.screenshot({path:join(screenshots,'reading-library-narrow-dark.png'),animations:'disabled'});
  assert.equal(modelCalls,0,'阅读库、导出和恢复不能产生模型请求');
  assert.deepEqual(libraryErrors,[],'隔离扩展的阅读库不应产生未处理的页面错误');
  await library.getByRole('link',{name:'帮助与诊断',exact:true}).click();
  await library.getByRole('button',{name:'运行诊断',exact:true}).click();
  await library.locator('#support-report').filter({hasText:'contextflow-support'}).waitFor();
  const diagnostic=JSON.parse(await library.locator('#support-report').textContent());
  assert.equal(diagnostic.extensionVersion,manifest.version);assert.equal(diagnostic.connection,'connected');
  assert.ok(diagnostic.storage.storedRows>=4);
  assert.doesNotMatch(JSON.stringify(diagnostic),/first-use-isolated|wrong-test-key|独立阅读库|备份补充|127\.0\.0\.1|\/Users\//);
  assert.equal(modelCalls,0,'诊断不得调用 AI');
  await library.screenshot({path:join(screenshots,'support-diagnostics-narrow.png'),animations:'disabled'});
  await library.close();
  console.log('ok 实际扩展阅读库：跨文章检索、图片预览、真实 Markdown/JSON 下载、预览/取消/确认恢复、重复导入、坏文件拒绝与窄屏；零 AI 请求');

  await options.locator('#configuration #s-baseUrl').fill(fixtureBase);
  await options.locator('#configuration #s-apiKey').fill('wrong-test-key');
  await options.locator('#configuration #s-model').fill('onboarding-test-model');
  await options.locator('#configuration #s-testModel').click();
  await options.locator('#configuration #s-modelStatus[role=alert]').filter({ hasText: '401' }).waitFor();
  assert.equal(modelCalls, 0, '无效密钥应给出明确错误，不假报成功');
  await options.locator('#configuration #s-apiKey').fill('onboarding-test-only');
  await options.locator('#configuration #s-fetchModels').click();
  await expectVisibleToast(options, '#configuration', '已获取到 2 个模型');
  assert.ok((await options.locator('#configuration #s-modelListStatus').textContent()).includes('已获取到 2 个模型'));
  await options.locator('#configuration #s-model').filter({ visible: true }).waitFor();
  await options.waitForFunction(() => document.getElementById('configuration').shadowRoot.getElementById('s-model').value === 'onboarding-test-model');
  await options.locator('#configuration #s-testModel').click();
  await options.locator('#configuration #s-modelStatus').filter({ hasText: '模型连接成功' }).waitFor();
  assert.equal(modelCalls, 1);
  assert.equal(await options.locator('#configuration #s-apiKey').inputValue(), 'onboarding-test-only', '测试不保存或清空草稿密钥');
  const unsaved = JSON.parse(readFileSync(join(config, 'config.json'), 'utf8'));
  assert.equal(unsaved.translate.apiKey, '', '获取和测试均不能把密钥写入配置');
  await options.locator('#configuration #s-save').click();
  await options.locator('#configuration #s-msg').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await options.locator('#configuration #s-apiKey').inputValue(), '');
  modelListMode = 'error';
  await options.locator('#configuration #s-fetchModels').click();
  await options.locator('#configuration #s-modelListStatus[role=alert]').filter({ hasText: '401' }).waitFor();
  await expectVisibleToast(options, '#configuration', '获取模型失败');
  modelListMode = 'empty';
  await options.locator('#configuration #s-fetchModels').click();
  await options.locator('#configuration #s-modelListStatus').filter({ hasText: '获取到 0 个模型' }).waitFor();
  assert.equal(await options.locator('#configuration #s-modelPickWrap').isVisible(), false);
  assert.equal(await options.locator('#configuration #s-model').inputValue(), 'onboarding-test-model');
  modelListMode = 'success';
  await options.locator('#configuration #s-fetchModels').click();
  await expectVisibleToast(options, '#configuration', '已获取到 2 个模型');
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await options.locator('#next-step').scrollIntoViewIfNeeded();
  await options.screenshot({ path: join(screenshots, 'onboarding-configured-390x844.png') });
  await options.setViewportSize({ width: 1280, height: 900 });
  await options.locator('#next-step').scrollIntoViewIfNeeded();
  await options.screenshot({ path: join(screenshots, 'onboarding-configured-1280x900.png') });
  console.log('ok 获取和测试不保存/清空草稿；只有明确保存才落盘；只调用隔离模拟模型，无真实费用');

  await article.getByRole('button', { name: '配置', exact: true }).click();
  const panel = '[data-contextflow="panel"]';
  await article.locator(`${panel} #s-state-translate`).filter({hasText:'连接已通过'}).waitFor();
  await article.locator(`${panel} #s-chapter-translate > summary`).click();
  assert.match(await article.locator(`${panel} #s-modelStatus`).textContent(),/上次模型测试通过/);
  assert.equal(modelCalls,1,'欢迎页测试并保存后，阅读页直接恢复测试记录，不调用模型');
  await article.locator(`${panel} #s-fetchModels`).click();
  await expectVisibleToast(article, panel, '已获取到 2 个模型');
  await article.locator(`${panel} #s-testModel`).click();
  await article.locator(`${panel} #s-modelStatus`).filter({ hasText: '模型连接成功' }).waitFor();
  await expectVisibleToast(article, panel, '模型连接成功');
  assert.equal(modelCalls, 2);
  await article.getByRole('button', { name: '返回阅读记录', exact: true }).click();
  await article.getByRole('tab', { name: '文章速览', exact: true }).click();
  await article.getByRole('button', { name: '生成速览', exact: true }).waitFor();
  await article.reload();
  await article.getByRole('tab', { name: '文章速览', exact: true }).click();
  await article.getByRole('button', { name: '生成速览', exact: true }).waitFor();
  assert.equal(modelCalls, 2, '已配置模型后展开、切回、刷新侧栏也不能自动调用 AI');
  await article.getByRole('button', { name: '配置', exact: true }).click();
  await article.locator(`${panel} #s-chapter-translate > summary`).click();
  await article.locator(`${panel} #s-fetchModels`).click();
  await expectVisibleToast(article, panel, '已获取到 2 个模型');
  assert.equal(await article.locator(`${panel} #s-fetchModels`).isEnabled(), true);
  assert.equal(await article.locator(`${panel} #s-testModel`).isEnabled(), true);
  await article.screenshot({ path: join(screenshots, 'model-feedback-sidebar.png') });
  console.log('ok 连接页及实际网页右侧栏：模型数量/空列表/失败反馈、可见 toast 与模型连接测试通过');

  await options.reload();
  await options.locator('#connection-state').filter({ hasText: '本地服务已连接' }).waitFor();
  await options.locator('#configuration #s-chapter-translate > summary').click();
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
  assert.equal(modelCalls, 2, '重启和连接检查不能自动调用模型');
  console.log('ok 重新打开恢复已保存配置，停止/重启服务保持原配对，不重新安装、不重复计费');

  // Actual extension → companion → fake provider, using only this test's data.
  const admin = async (path, body) => {
    const result = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer first-use-isolated', 'Content-Type': 'application/json', 'X-ContextFlow': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(result.ok, true); return result.json();
  };
  const configBeforeAgent=readFileSync(join(config,'config.json'),'utf8');
  const settingsRoot='#configuration';
  await options.locator(`${settingsRoot} #s-chapter-explain > summary`).click();
  await options.locator(`${settingsRoot} #s-exBackend`).selectOption('agent');
  await options.locator(`${settingsRoot} #s-agentDiscoveryStatus`).filter({hasText:'检测到 4 个'}).waitFor();
  await options.locator(`${settingsRoot} #s-agent`).selectOption('claude');
  await options.locator(`${settingsRoot} #s-testAgent`).click();
  await options.locator(`${settingsRoot} #s-agentTestStatus`).filter({hasText:'连接测试通过'}).waitFor();
  assert.equal(await options.locator(`${settingsRoot} #s-agentReady`).textContent(),'可用');
  const requestLog=JSON.parse(readFileSync(agentRecord,'utf8'));
  assert.equal(requestLog.argv[requestLog.argv.indexOf('--tools')+1],'');
  assert.equal(requestLog.argv.includes('--add-dir'),false);
  assert.ok(requestLog.prompt.includes('Connection check only'));
  assert.equal(requestLog.prompt.includes('阅读的价值'),false);
  assert.equal(readFileSync(join(config,'config.json'),'utf8'),configBeforeAgent,'Agent 测试不能保存草稿或权限');
  writeFileSync(agentMode,'auth');
  await options.locator(`${settingsRoot} #s-testAgent`).click();
  await options.locator(`${settingsRoot} #s-agentTestStatus[role=alert]`).filter({hasText:'登录'}).waitFor();
  assert.equal(await options.locator(`${settingsRoot} #s-testAgent`).isEnabled(),true);
  assert.equal((await admin('/agents/detect')).connectionChecks.agents.claude.ok,false,'新的认证失败替换旧成功记录');
  writeFileSync(agentMode,'hold');
  await options.locator(`${settingsRoot} #s-testAgent`).click();
  for(let i=0;i<150;i++){
    const health=await admin('/health');
    if(health.jobs.running && JSON.parse(readFileSync(agentRecord,'utf8')).mode==='hold')break;
    if(i===149)throw new Error('模拟 CLI 未开始等待');
    await new Promise(done=>setTimeout(done,30));
  }
  await options.locator(`${settingsRoot} #s-cancelAgentTest`).click();
  await options.locator(`${settingsRoot} #s-agentTestStatus`).filter({hasText:'测试已取消'}).waitFor();
  for(let i=0;i<150;i++){
    try{if(readFileSync(agentCanceled,'utf8')==='canceled')break;}catch{}
    if(i===149)throw new Error('取消没有中断测试 CLI');
    await new Promise(done=>setTimeout(done,30));
  }
  writeFileSync(agentMode,'success');
  await options.locator(`${settingsRoot} #s-testAgent`).click();
  await options.locator(`${settingsRoot} #s-agentTestStatus`).filter({hasText:'连接测试通过'}).waitFor();
  assert.equal(readFileSync(join(config,'config.json'),'utf8'),configBeforeAgent);
  await options.locator(`${settingsRoot} #s-chapter-explain > summary`).click();
  await options.locator(`${settingsRoot} #s-chapter-explain > summary`).click();
  await options.locator(`${settingsRoot} #s-agent`).waitFor();
  assert.equal(await options.locator(`${settingsRoot} #s-agent`).inputValue(),'claude','折叠往返不重建或清空草稿');
  await options.screenshot({path:join(screenshots,'agent-connection-settings.png')});
  console.log('ok 实际扩展 Agent：安装状态、固定短消息成功、登录失败、取消真实 CLI、重试与配置不落盘；章节状态明确且草稿保留');
  await options.locator(`${settingsRoot} #s-save`).click();
  await options.locator(`${settingsRoot} #s-msg`).filter({hasText:'已保存'}).waitFor();
  const verified=(await admin('/config')).connectionChecks;
  assert.equal(verified.model.ok,true);assert.equal(verified.agents.claude.ok,true);
  const callsBeforeRestore=modelCalls,agentBeforeRestore=readFileSync(agentRecord,'utf8');
  await options.reload();
  await options.locator(`${settingsRoot} #s-state-translate`).filter({hasText:'连接已通过'}).waitFor();
  await options.locator(`${settingsRoot} #s-chapter-explain > summary`).click();
  await options.locator(`${settingsRoot} #s-agentReady`).filter({hasText:'可用'}).waitFor();
  await article.reload();
  await article.getByRole('button',{name:'配置',exact:true}).click();
  await article.locator(`${panel} #s-state-translate`).filter({hasText:'连接已通过'}).waitFor();
  await article.locator(`${panel} #s-chapter-explain > summary`).click();
  await article.locator(`${panel} #s-agentReady`).filter({hasText:'可用'}).waitFor();
  assert.match(await article.locator(`${panel} #s-agentConnection`).textContent(),/已通过 ·/);
  const help=article.getByRole('button',{name:'了解两种回答方式的能力范围'});
  await help.click();
  await article.getByRole('region',{name:'两种回答方式有什么不同？'}).waitFor();
  await article.screenshot({path:join(screenshots,'connection-history-answer-help.png')});
  await help.press('Escape');
  assert.equal(await help.getAttribute('aria-expanded'),'false');
  assert.equal(modelCalls,callsBeforeRestore);assert.equal(readFileSync(agentRecord,'utf8'),agentBeforeRestore);
  await stopService();start(restart);await waitForHealth();
  const restored=(await admin('/config')).connectionChecks;
  assert.equal(restored.model.checkedAt,verified.model.checkedAt);assert.equal(restored.agents.claude.checkedAt,verified.agents.claude.checkedAt);
  const changedKey=await admin('/config',{translate:{apiKey:'replacement-test-key'}});
  assert.equal(changedKey.connectionChecks.model,null,'同模型和地址但密钥已变，不能沿用旧测试');
  await article.reload();await article.getByRole('button',{name:'配置',exact:true}).click();
  await article.locator(`${panel} #s-state-translate`).filter({hasText:'待测试'}).waitFor();
  const changedModel=await admin('/config',{translate:{apiKey:'onboarding-test-only',model:'alternate-test-model'}});
  assert.equal(changedModel.connectionChecks.model,null,'改模型也不沿用旧测试');
  const originalConnection=await admin('/config',{translate:{model:'onboarding-test-model'}});
  assert.equal(originalConnection.connectionChecks.model.checkedAt,verified.model.checkedAt);
  await options.locator(`${settingsRoot} #s-exBackend`).selectOption('llm');
  await options.locator(`${settingsRoot} #s-save`).click();
  await options.locator(`${settingsRoot} #s-msg`).filter({hasText:'已保存'}).waitFor();
  console.log('ok 欢迎页 → 阅读设置 → 刷新/服务重启共用带时间的 LLM 与 Agent 记录；恢复零 AI 调用；问号说明可点击和 Esc 收起');
  const key = article.url().toLowerCase();
  const saved = (await admin(`/events?urlKey=${encodeURIComponent(key)}`)).events;
  const source = saved.find(e => e.action === 'highlight'); assert.ok(source);
  const longAnswer = '这是需要折叠的长回答，阅读时不会挤走下面的记录。'.repeat(45);
  await admin('/events', { events: [
    { ...source, id: 'qa-workbench-explain', action: 'explain', color: null, value: longAnswer,
      extra: { question: '解释这一段', supplement: '已有的个人补充' }, updatedAt: Date.now(), mutationId:'qa-explain' },
    { ...source, id: 'qa-workbench-translate', action: 'translate', color: null, value: 'A translated selection.',
      extra: { target: 'English' }, updatedAt: Date.now(), mutationId:'qa-translate' },
  ] });
  await article.reload();
  await article.getByRole('tab', { name: /阅读记录/ }).click();
  const records = article.locator(`${panel} #p-records`);
  const row = records.locator('[data-id="qa-workbench-explain"]');
  await row.waitFor();
  assert.equal(await records.locator('.source-group').count(),1,'同一选区的批注、解释、翻译只显示一次引文');
  assert.equal(await row.locator('.answer-details').getAttribute('open'),null);
  await row.locator('.answer-details > summary').click();
  await row.locator('.ans').filter({hasText:longAnswer}).waitFor();
  await row.locator('.answer-details > summary').click();
  await records.getByRole('button', {name:/^翻译/}).click();
  assert.equal(await row.isVisible(),false);
  await records.getByRole('button', {name:/^全部/}).click();
  await records.getByRole('searchbox').fill('个人补充');
  assert.equal(await row.isVisible(),true);
  assert.equal(await records.locator('[data-id="qa-workbench-translate"]').isVisible(),false);
  await records.getByRole('searchbox').fill('');
  await article.screenshot({path:join(screenshots,'reading-workbench.png')});
  aiBehavior = 'hold';
  await row.getByRole('button',{name:'重新生成',exact:true}).click();
  await row.getByRole('button',{name:'取消生成',exact:true}).waitFor();
  const supplement = row.locator('textarea');
  await supplement.fill('生成期间继续输入，不丢光标');
  await article.waitForFunction(() => document.querySelector('[data-contextflow="panel"]').shadowRoot.querySelector('[data-id="qa-workbench-explain"] .status-text').textContent.length > 0);
  assert.equal(await supplement.inputValue(),'生成期间继续输入，不丢光标');
  for (let i=0; i<100 && !upstreamWaiting;i++) await new Promise(done=>setTimeout(done,50));
  assert.equal(upstreamWaiting,true);
  await row.getByRole('button',{name:'取消生成',exact:true}).click();
  await row.locator('.status-text').filter({hasText:'已取消'}).waitFor();
  for (let i=0; i<100 && !upstreamCanceled;i++) await new Promise(done=>setTimeout(done,50));
  assert.equal(upstreamCanceled,true,'取消必须中断实际的模拟模型连接，不只停止轮询');
  assert.equal(await row.locator('.ans').textContent(),longAnswer);
  aiBehavior = 'answer';
  await row.getByRole('button',{name:'重新生成',exact:true}).click();
  await row.locator('.ans').filter({hasText:'重新生成后的模拟答案'}).waitFor();
  assert.equal(await row.locator('textarea').inputValue(),'生成期间继续输入，不丢光标');
  await row.locator('.answer-history > summary').click();
  assert.ok((await row.locator('.answer-history').textContent()).includes(longAnswer));
  await row.getByRole('button',{name:'删除',exact:true}).click();
  await row.waitFor({state:'detached'});
  await article.getByRole('button',{name:'撤销删除',exact:true}).click();
  await row.waitFor();
  assert.equal(await row.locator('textarea').inputValue(),'生成期间继续输入，不丢光标');
  await article.reload();
  await row.waitFor();
  assert.equal(await row.locator('textarea').inputValue(),'生成期间继续输入，不丢光标');
  await article.setViewportSize({width:390,height:844});
  await article.waitForFunction(() => {
    const rect = document.querySelector('[data-contextflow=panel]').shadowRoot.getElementById('wrap').getBoundingClientRect();
    return rect.x >= 0 && rect.right <= 391;
  });
  await article.screenshot({path:join(screenshots,'reading-workbench-narrow.png')});
  assert.equal(await records.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  const narrowBox = await article.locator(`${panel} #wrap`).boundingBox();
  assert.ok(narrowBox.x >= 0 && narrowBox.x+narrowBox.width <= 391,
    JSON.stringify({message:'整个侧栏必须在窄视口内',narrowBox,metrics:await article.evaluate(()=>({innerWidth,client:document.documentElement.clientWidth,visual:visualViewport?.width,margin:document.documentElement.style.marginRight,left:document.querySelector('[data-contextflow=panel]').shadowRoot.getElementById('wrap').style.left}))}));
  assert.equal(await article.locator(`${panel} #wrap`).evaluate(el=>el.classList.contains('float')),true);
  await article.setViewportSize({width:1280,height:900});
  const separator=article.getByRole('separator',{name:'调整侧栏宽度',exact:true});
  await separator.focus();await separator.press('Enter');await separator.press('ArrowLeft');
  assert.equal(await separator.getAttribute('aria-valuenow'),'380');
  await separator.press('Escape');
  assert.equal(await article.locator(`${panel} #wrap`).evaluate(el=>el.inert),true);
  assert.equal(await article.getByRole('button',{name:'展开 ContextFlow',exact:true}).evaluate(el=>el===el.getRootNode().activeElement),true);
  await article.getByRole('button',{name:'展开 ContextFlow',exact:true}).press('Enter');
  await separator.focus();await separator.press('Enter');
  await article.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});
  await article.screenshot({path:join(screenshots,'reading-workbench-forced-colors.png'),animations:'disabled'});
  await article.emulateMedia({reducedMotion:'no-preference',forcedColors:'none'});
  aiBehavior = 'check';
  console.log('ok 实际扩展阅读工作台：同选区分组、搜索筛选、长回答、输入保持、真正取消上游、历史答案及删除撤销刷新恢复');
  const savedConfig = readFileSync(join(config, 'config.json'), 'utf8');
  const pairing = readFileSync(join(config, 'extension-pairings.json'), 'utf8');
  // 模拟旧进程的健康响应；只作用于本测试临时扩展，不切换端口或触碰用户服务。
  await worker.evaluate(() => {
    const originalFetch = self.fetch;
    self.legacyModelRequests = 0;
    self.fetch = async (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (path === '/health') return new Response(JSON.stringify({ ok: true, extensionPaired: true, serviceVersion: '0.3.1', capabilities: ['llm.test'] }), { headers: { 'Content-Type': 'application/json' } });
      if (path.startsWith('/llm/') || path === '/config' && init?.method === 'POST') self.legacyModelRequests++;
      return originalFetch(input, init);
    };
  });
  await options.locator('#check-connection').click();
  await options.locator('#connection-state').filter({ hasText: '版本能力不足' }).waitFor();
  assert.equal(await options.locator('#update-help').isVisible(), true);
  assert.equal(await options.locator('#pair-section').isVisible(), false);
  assert.equal(await options.locator('#service-version').textContent(), '0.3.1');
  if(await options.locator('#configuration #s-chapter-translate').getAttribute('open')===null) await options.locator('#configuration #s-chapter-translate > summary').click();
  await options.locator('#configuration #s-testModel').click();
  await options.locator('#configuration #s-modelStatus[role=alert]').filter({ hasText: '更新配套服务' }).waitFor();
  assert.equal(await worker.evaluate(() => self.legacyModelRequests), 0, '旧服务不能回退为隐式保存或不支持的模型请求');
  assert.equal(readFileSync(join(config, 'config.json'), 'utf8'), savedConfig);
  assert.equal(readFileSync(join(config, 'extension-pairings.json'), 'utf8'), pairing);
  console.log('ok 旧服务：展示版本与更新指引，不要求重配对，不隐式保存，也不发起模型请求');
} catch (error) {
  if (options) await options.screenshot({ path: join(screenshots, 'first-use-failure-options.png') });
  if (article) {
    await article.screenshot({ path: join(screenshots, 'first-use-failure-article.png') });
    console.error(await article.locator('[data-contextflow="panel"]').evaluate(el=>el.shadowRoot?.getElementById('syncmsg')?.textContent));
  }
  throw error;
} finally {
  if (context) await context.close();
  await stopService();
  if (fixture) { fixture.closeAllConnections(); await new Promise((done) => fixture.close(done)); }
  rmSync(temporary, { recursive: true, force: true });
}

async function expectVisibleToast(page, scope, text) {
  const toast = page.locator(`${scope} #s-toast`);
  await toast.filter({ hasText: text }).waitFor({ state: 'visible' });
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `toast 在 ${scope} 中必须完整可见`);
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, 'toast 不应横向溢出');
}
