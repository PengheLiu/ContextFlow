import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { stageWebsite, websiteFiles } from '../tools/build-website.mjs';

const directory = mkdtempSync(join(tmpdir(), 'contextflow-website-test-'));
const base = 'https://pengheliu.github.io/ContextFlow/';
const store = 'https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm';
const release = JSON.parse(readFileSync(new URL('../product/release.json', import.meta.url), 'utf8'));
assert.equal(release.desktop.updateMode, 'manual', '桌面客户端不承诺未验收自动安装');
const desktopRelease = release.desktop.platforms['darwin-arm64'];
try {
  stageWebsite(directory);
  assert.equal(websiteFiles.length, new Set(websiteFiles.map(([, target]) => target)).size);
  for (const [, target] of websiteFiles) {
    assert.ok(existsSync(join(directory, target)), `发布资源缺失：${target}`);
    assert.ok(!relative(directory, resolve(directory, target)).startsWith('..'));
  }
  for (const file of ['index.html', 'download.html', 'privacy.html', 'demo.html']) {
    const html = readFileSync(join(directory, file), 'utf8');
    assert.doesNotMatch(html, /\/Users\/|__CONTEXTFLOW_TOKEN__|cf-test-token-/);
    const dom = new JSDOM(html, { url: new URL(file, base).href });
    const { document } = dom.window;
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.ok(document.title);
    assert.doesNotMatch(document.body.textContent, /预览|候选/, '官网使用客户端独立分发说明，不保留版本标签或相关旧文案');
    assert.doesNotMatch(document.body.textContent, /(?<![\d.])1\.0(?:\.0)?(?![\d.])|CLI|命令行服务|等待升级|等待商店|旧版|历史兼容/, '官网面向完整新产品，不显示历史迁移或等待升级叙事');
    assert.equal(document.querySelectorAll('a[href*="/blob/v1.0.0/"]').length, 0, '官网不提供历史版本文档CTA');
    assert.doesNotMatch(document.body.textContent, /(?:扩展|Chrome)[^。]*1\.1[^。]*(?:已上线|已通过审核)/, '不凭桌面分发宣称Chrome更新已上线');
    assert.equal(document.querySelectorAll('h1').length, 1);
    assert.equal(document.querySelectorAll('script, iframe, form').length, 0, '官网保持纯静态，不添加遥测或账户');
    const ids = Array.from(document.querySelectorAll('[id]'), element => element.id);
    assert.equal(ids.length, new Set(ids).size, '不应有重复的锚点 ID');
    for (const element of document.querySelectorAll('[href], img[src]')) {
      const href = element.getAttribute(element.hasAttribute('href') ? 'href' : 'src');
      const url = new URL(href, document.URL);
      assert.equal(url.protocol, 'https:', `链接必须安全：${href}`);
      if (url.origin !== new URL(base).origin) continue;
      assert.ok(url.pathname.startsWith('/ContextFlow/'), `站内资源越界：${href}`);
      const path = decodeURIComponent(url.pathname.slice('/ContextFlow/'.length)) || 'index.html';
      assert.ok(existsSync(join(directory, path)), `资源或链接不可用：${href}`);
      if (url.hash) {
        const targetDOM = new JSDOM(readFileSync(join(directory, path), 'utf8'));
        assert.ok(targetDOM.window.document.getElementById(decodeURIComponent(url.hash.slice(1))), `锚点不可用：${href}`);
        targetDOM.window.close();
      }
    }
    if (file === 'index.html') {
      assert.equal(document.querySelector('link[rel="canonical"]').href, base);
      assert.equal(document.querySelector('meta[property="og:url"]').content, base);
      const image = document.querySelector('meta[property="og:image"]').content;
      assert.ok(existsSync(join(directory, new URL(image).pathname.slice('/ContextFlow/'.length))));
      assert.equal(document.querySelector('.hero-copy .button').href, store);
      assert.ok(document.querySelector('a[href="demo.html"]'));
      assert.ok(document.querySelector('a[href="privacy.html"]'));
      assert.equal(document.querySelectorAll('details > summary').length, 6);
      assert.match(document.body.textContent, /模型费用另计/);
      assert.match(document.body.textContent, /卸载扩展会清除/);
      assert.ok(document.querySelector('a[href="download.html"]'), '桌面端后续步骤从官网承接');
      assert.match(document.body.textContent, /不要求最终用户安装 Node.js/);
      assert.match(document.querySelector('.hero-copy .release-notice').textContent,/未使用 Developer ID 签名、未通过 Apple 公证/);
      const releaseNotice = document.querySelector('.hero-copy .release-notice');
      assert.equal(releaseNotice.dataset.desktopVersion, desktopRelease.version);
      assert.equal(releaseNotice.dataset.publishedVersion, release.publishedExtension.version);
      assert.ok(releaseNotice.textContent.includes(release.candidateVersion));
      assert.match(document.querySelector('.product-figure figcaption').textContent, /实际阅读界面/);
      assert.doesNotMatch(document.body.textContent, /目前通过终端安装和启动|本地服务需要 Node.js 22.13\+/,'CLI 不再是普通用户默认路径');
      assert.equal(document.querySelectorAll('.desktop-journey .journey-steps > li').length, 4);
    }
    if (file === 'download.html') {
      assert.equal(document.querySelector('link[rel="canonical"]').href, `${base}download.html`);
      const installHelp = document.querySelector(`header a[href="${store}"]`);
      assert.equal(installHelp.textContent, '还没安装扩展？');
      assert.equal(installHelp.classList.contains('button'), false, '已安装用户的下载后续页不应再次强调安装扩展');
      assert.ok(installHelp.classList.contains('text-link'));
      assert.match(document.querySelector('h1').textContent, /阅读留在浏览器/);
      assert.equal(document.querySelectorAll('.download-breadcrumb > li').length, 3);
      assert.match(document.querySelector('.download-breadcrumb li').textContent, /安装 Chrome 扩展/);
      const platforms = [...document.querySelectorAll('[data-platform]')];
      assert.deepEqual(platforms.map(el => el.dataset.platform), ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']);
      for (const platform of platforms) {
        assert.equal(platform.querySelector('[data-availability]').dataset.availability, release.desktop.platforms[platform.dataset.platform].status);
        if (platform.dataset.platform === 'darwin-arm64') {
          assert.equal(platform.querySelector('[data-download="desktop"]').href, desktopRelease.downloadUrl);
          assert.equal(platform.querySelector('[data-download="checksum"]').href, desktopRelease.checksumUrl);
          assert.equal(platform.querySelectorAll('a').length, 2);
          assert.match(platform.textContent, /未使用 Developer ID 签名、未通过 Apple 公证/);
        } else {
          assert.match(platform.textContent, /尚未公开下载|尚未开放下载/);
          assert.equal(platform.querySelector('a, button'), null, '未开放平台不提供下载按钮');
        }
      }
      assert.equal(document.querySelectorAll('a[download]').length, 0);
      assert.equal(document.querySelectorAll('a[href*="/releases/download/"]').length, 2, '仅提供已指定Mac安装包及校验文件');
      assert.equal(desktopRelease.status, 'available-unsigned');
      assert.equal(desktopRelease.signing, 'unsigned-unnotarized');
      assert.match(desktopRelease.sha256, /^[a-f0-9]{64}$/);
      assert.match(document.querySelector('.release-status').textContent, /未使用 Developer ID 签名、未通过 Apple 公证/);
      assert.match(document.querySelector('.release-status').textContent, /不要关闭系统保护/);
      assert.match(document.querySelector('.release-status').textContent, /不代表 Apple 安全认可/);
      assert.equal(document.querySelector('.release-status').dataset.desktopVersion, desktopRelease.version);
      assert.equal(document.querySelector('.release-status').dataset.publishedVersion, release.publishedExtension.version);
      assert.match(document.body.textContent, /不会仅凭浏览器名称猜测你的芯片/);
      assert.match(document.body.textContent, /不会扫描整块磁盘/);
      assert.match(document.body.textContent, /发现不等于登录、授权或测试通过/);
      assert.match(document.body.textContent, /Obsidian 已登记/);
      assert.match(document.body.textContent, /先测试当前草稿，通过后保存/);
      assert.match(document.body.textContent, /只发送固定短消息/);
      assert.doesNotMatch(document.body.textContent, /安装之后，只需一次确认/);
      assert.match(document.querySelector('#connect').textContent, /连接桌面端/);
      assert.match(document.querySelector('#connect').textContent, /允许连接/);
      assert.match(document.querySelector('#connect').textContent, /不需要复制配对码/);
      assert.doesNotMatch(document.querySelector('#connect').textContent, /生成并复制|重置并复制|连接商店/);
      assert.ok(document.querySelector('a[href="demo.html"]'));
      assert.ok(document.querySelector('a[href="https://github.com/PengheLiu/ContextFlow/blob/main/docs/GETTING_STARTED.md"]'));
      assert.match(document.body.textContent, /桌面端采用手动更新/);
    }
    if (file === 'privacy.html') {
      assert.match(document.body.textContent, /阅读数据库、图片、导出的文件和原始日志本身不宣称加密/);
      assert.match(document.body.textContent, /本机恢复点/);
      assert.match(document.body.textContent, /摘要标识、结果与时间/);
      assert.match(document.body.textContent, /设置与帮助.*浏览器授权/);
      assert.match(document.body.textContent, /不等于撤销服务端授权/);
      assert.match(document.body.textContent, /不截屏、不读取其他应用窗口内容/);
      assert.match(document.body.textContent, /GitHub Pages/);
      assert.match(document.body.textContent, /原始日志不属于脱敏报告/);
      assert.match(document.body.textContent, /不在后台自动下载或安装/);
      assert.doesNotMatch(document.body.textContent, /共享这一授权|生成并复制|重置并复制|连接商店/);
    }
    dom.window.close();
  }
  const css = readFileSync(join(directory, 'site.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, '无第三方字体、追踪或外部样式依赖');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /\.download-grid\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(css, /\.download-grid\{grid-template-columns:1fr/);
  const listing = readFileSync(new URL('../store/LISTING.zh-CN.md', import.meta.url), 'utf8');
  assert.ok(listing.includes(`**${release.candidateVersion} 桌面连接更新**`));
  assert.match(listing, /桌面客户端独立分发/);
  assert.match(listing, /未使用 Developer ID 签名、未通过 Apple 公证/);
  assert.doesNotMatch(listing, /预览|候选/);
  assert.match(listing, /点击「连接桌面端」.*确认「允许连接」/);
  assert.doesNotMatch(listing, /1\.0\.0 已提交待审核|后台确认已送审|目前尚未上线/);
  for (const file of ['README.md', 'README.en.md', 'docs/GETTING_STARTED.md']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /https:\/\/pengheliu.github.io\/ContextFlow\/download.html/, `${file} 的桌面入口应统一到官网`);
  }
  console.log('官网：扩展优先、桌面下载状态、系统架构、无假下载、站内链接/资源、SEO、无遥测与兼容路径检查通过');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
