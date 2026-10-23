// Visual acceptance for the staged public website. Uses a disposable browser
// context and a loopback-only random port; never the user's Chrome profile.
// Run after npm run build:website:
// CONTEXTFLOW_PLAYWRIGHT_DIR=<runtime containing playwright> node test/desktop-site-browser.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { websiteFiles } from '../tools/build-website.mjs';

const runtime = process.env.CONTEXTFLOW_PLAYWRIGHT_DIR;
if (!runtime) throw new Error('Set CONTEXTFLOW_PLAYWRIGHT_DIR to the existing runtime containing playwright.');
const { chromium } = createRequire(join(resolve(runtime), 'package.json'))('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const website = join(root, 'release', 'website');
const evidence = join(root, 'release', 'product-evidence');
const release = JSON.parse(readFileSync(join(root, 'product', 'release.json'), 'utf8'));
const desktopRelease = release.desktop.platforms['darwin-arm64'];
const files = new Set(websiteFiles.map(([, destination]) => destination));
for (const file of files) assert.ok(existsSync(join(website, file)), `请先构建官网，缺少 ${file}`);
mkdirSync(evidence, { recursive: true });
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png' };
const prefix = '/ContextFlow/';
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const name = path === prefix ? 'index.html' : path.startsWith(prefix) ? path.slice(prefix.length) : '';
  if (!files.has(name)) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)] || 'application/octet-stream' });
  response.end(readFileSync(join(website, name)));
});
const storeURL = 'https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm';
let browser, context, page;
const checkedLinks = new Set();
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const homeURL = origin + prefix;
  browser = await chromium.launch({ channel: 'chromium', headless: true,
    executablePath: process.env.CONTEXTFLOW_CHROMIUM_PATH || undefined });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const issues = [], externalRequests = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) {
        externalRequests.push(route.request().url()); return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => issues.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') issues.push(`console: ${message.text()}`); });
    page.on('response', response => { if (response.status() >= 400) issues.push(`HTTP ${response.status()}: ${response.url()}`); });
    const layout = async label => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true });
        })));
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: 页面不能横向溢出`);
      assert.deepEqual(await page.evaluate(() => [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => image.getAttribute('src'))), [], `${label}: 图片必须实际加载`);
      const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.href));
      for (const href of new Set(links)) {
        const target = new URL(href);
        if (target.origin !== origin || checkedLinks.has(href)) continue;
        assert.ok(target.pathname.startsWith(prefix), `内部链接应保留 GitHub Pages 子路径: ${href}`);
        const response = await fetch(href);
        assert.equal(response.ok, true, `内部链接不存在: ${href}`);
        if (target.hash) {
          const html = await response.text();
          assert.ok(html.includes(`id="${decodeURIComponent(target.hash.slice(1))}"`), `锚点不存在: ${href}`);
        }
        checkedLinks.add(href);
      }
      assert.deepEqual(issues, [], `${label}: 无页面、资源或 console 错误`);
      assert.deepEqual(externalRequests, [], `${label}: 静态官网不得自动请求外部服务`);
    };
    const size = `${viewport.width}x${viewport.height}`;
    await page.goto(homeURL, { waitUntil: 'networkidle' });
    await page.locator('#hero-title').waitFor();
    assert.equal(await page.locator('.hero-copy .button').getAttribute('href'), storeURL, '首页主行动必须先安装 Chrome 扩展');
    assert.doesNotMatch(await page.locator('body').textContent(), /预览|候选/);
    assert.equal(await page.locator('.release-notice').getAttribute('data-desktop-version'), desktopRelease.version);
    assert.equal(await page.locator('.release-notice').getAttribute('data-published-version'), release.publishedExtension.version);
    assert.match(await page.locator('#desktop-extension-requirement').textContent(), /ContextFlow Chrome 扩展 1\.1\.0 或更高版本/);
    assert.match(await page.locator('#desktop-extension-requirement').textContent(), /下载前.*「连接桌面端」入口.*商店可安装版本以实际页面为准/);
    await layout(`首页 ${size}`);
    await page.screenshot({ path: join(evidence, `website-home-${size}.png`) });
    await page.locator('.site-header .nav-links a[href="download.html"]').click();
    await page.waitForURL(homeURL + 'download.html');
    await page.locator('#download-title').waitFor();
    assert.equal(await page.locator('.site-header a[href="' + storeURL + '"]').count(), 1);
    assert.equal(await page.locator('.site-header a[href="' + storeURL + '"]').getAttribute('class'), 'text-link', '已安装扩展的下载页不再强推重复安装');
    assert.match(await page.locator('.download-breadcrumb').textContent(), /01 安装 Chrome 扩展.*02 连接桌面端.*03 回到阅读/);
    assert.match(await page.locator('#release-status-title').textContent(), /桌面客户端 1.1.0/);
    assert.match(await page.locator('.release-status').textContent(), /未使用 Developer ID 签名、未通过 Apple 公证/);
    assert.match(await page.locator('.release-status').textContent(), /不要关闭系统保护/);
    assert.equal(await page.locator('.release-status').getAttribute('data-desktop-version'), desktopRelease.version);
    assert.equal(await page.locator('.release-status').getAttribute('data-published-version'), release.publishedExtension.version);
    const connectionRequirement = page.locator('#desktop-extension-requirement');
    assert.equal(await connectionRequirement.isVisible(), true, '下载前直接展示一键连接要求，不折叠到帮助中');
    assert.match(await connectionRequirement.textContent(), /ContextFlow Chrome 扩展 1\.1\.0 或更高版本/);
    assert.match(await connectionRequirement.textContent(), /下载前.*「连接与设置」.*「连接桌面端」入口/);
    assert.match(await connectionRequirement.textContent(), /商店可安装版本以实际页面为准/);
    assert.match(await connectionRequirement.textContent(), /没有入口.*继续高亮、批注与 Markdown 导出.*不要卸载扩展/);
    assert.equal(await page.locator('.download-option').count(), 4);
    const platforms = await page.locator('.download-option').evaluateAll(cards => cards.map(card => ({
      platform: card.dataset.platform,
      heading: card.querySelector('.platform-heading').textContent.trim(),
      availability: card.querySelector('.availability').dataset.availability,
      status: card.querySelector('.availability').textContent.trim(),
      explanation: card.querySelector('.platform-note').textContent.trim(),
      downloads: card.querySelectorAll('a[download],a[href],button').length,
    })));
    assert.deepEqual(platforms.map(platform => platform.platform), ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']);
    for (const platform of platforms) {
      assert.equal(platform.availability, release.desktop.platforms[platform.platform].status);
      assert.ok(platform.heading && platform.explanation);
      if (platform.platform === 'darwin-arm64') {
        assert.equal(platform.availability, 'available-unsigned');
        assert.equal(platform.downloads, 2);
      } else {
        assert.equal(platform.availability, 'unpublished');
        assert.match(platform.status, /尚未公开下载|尚未开放下载/);
        assert.equal(platform.downloads, 0, `${platform.platform}: 未开放平台无下载控件`);
      }
    }
    assert.equal(await page.locator('[data-download="desktop"]').getAttribute('href'), desktopRelease.downloadUrl);
    assert.equal(await page.locator('[data-download="checksum"]').getAttribute('href'), desktopRelease.checksumUrl);
    assert.equal(await page.locator('a[href$=".exe"]').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /预览|候选/);
    assert.match(await page.locator('#connect').textContent(), /先测试当前草稿，通过后保存/);
    assert.match(await page.locator('#connect').textContent(), /连接桌面端/);
    assert.match(await page.locator('#connect').textContent(), /允许连接/);
    assert.match(await page.locator('#connect').textContent(), /不需要复制配对码/);
    assert.doesNotMatch(await page.locator('#connect').textContent(), /生成并复制|重置并复制|连接商店|等待升级/);
    await layout(`下载页 ${size}`);
    await page.screenshot({ path: join(evidence, `website-download-${size}.png`) });
    await page.locator('.download-hero a[href="#platforms"]').click();
    assert.equal(new URL(page.url()).hash, '#platforms');
    await page.locator('#platform-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `website-platforms-${size}.png`) });
    const help = page.locator('.architecture-help');
    await help.locator('summary').click();
    assert.equal(await help.getAttribute('open'), '');
    assert.equal(await help.locator('.faq-answer').isVisible(), true);
    await page.locator('.connect-section a[href="demo.html"]').click();
    await page.waitForURL(homeURL + 'demo.html');
    assert.equal(await page.locator('article').count(), 1, '练习文章是实际可访问的内部页面');
    await page.goto(homeURL + 'privacy.html', { waitUntil: 'networkidle' });
    assert.doesNotMatch(await page.locator('body').textContent(), /预览|候选/);
    assert.doesNotMatch(await page.locator('body').textContent(), /生成并复制|重置并复制|连接商店|命令行服务/);
    await layout(`隐私页 ${size}`);
    await page.screenshot({ path: join(evidence, `website-privacy-${size}.png`) });
    await page.goto(homeURL + 'download.html', { waitUntil: 'networkidle' });
    await page.locator('.site-header .brand').click();
    await page.waitForURL(homeURL);
    await page.locator('#hero-title').waitFor();
    assert.deepEqual(issues, [], `${size}: 导航全程无错误`);
    assert.deepEqual(externalRequests, [], `${size}: 不向外部请求或上报`);
    console.log(`${size}: 官网先安装扩展→下载状态→系统架构→练习文章→返回首页；资源/锚点/无假下载/无溢出/无 console 错误通过`);
    await context.close(); context = null; page = null;
  }
  console.log(`官网视觉验收截图：${evidence}`);
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'website-acceptance-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
