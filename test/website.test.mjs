import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { stageWebsite, websiteFiles } from '../tools/build-website.mjs';

const directory = mkdtempSync(join(tmpdir(), 'contextflow-website-test-'));
const base = 'https://pengheliu.github.io/ContextFlow/';
const store = 'https://chromewebstore.google.com/detail/contextflow/aemncphfnlpbhlddifhohpgegejjejfm';
try {
  stageWebsite(directory);
  assert.equal(websiteFiles.length, new Set(websiteFiles.map(([, target]) => target)).size);
  for (const [, target] of websiteFiles) {
    assert.ok(existsSync(join(directory, target)), `发布资源缺失：${target}`);
    assert.ok(!relative(directory, resolve(directory, target)).startsWith('..'));
  }
  for (const file of ['index.html', 'privacy.html', 'demo.html']) {
    const html = readFileSync(join(directory, file), 'utf8');
    assert.doesNotMatch(html, /\/Users\/|__CONTEXTFLOW_TOKEN__|cf-test-token-/);
    const dom = new JSDOM(html, { url: new URL(file, base).href });
    const { document } = dom.window;
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.ok(document.title);
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
      assert.match(document.body.textContent, /Node.js 22.13\+/);
      assert.match(document.body.textContent, /已提交审核/);
    }
    dom.window.close();
  }
  const css = readFileSync(join(directory, 'site.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, '无第三方字体、追踪或外部样式依赖');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\(max-width:760px\)/);
  console.log('官网：白名单发布、站内链接/锚点/资源、商店入口、SEO、无遥测、版本与配置说明检查通过');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
