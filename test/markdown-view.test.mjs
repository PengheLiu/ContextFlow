// AI 回答 Markdown 预览：只允许一小组被动、安全的 DOM 节点。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="out"></div></body>');
for (const k of ['window', 'document', 'HTMLElement', 'Node']) global[k] = dom.window[k];
const { renderMarkdownInto } = await import('../src/skill/markdown-view.js');

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const out = () => document.getElementById('out');

console.log('安全 Markdown 预览\n');

t('标题、段落、列表、引用与代码渲染为语义节点', () => {
  renderMarkdownInto(out(), '# 标题\n\n一段 **粗体** 和 `code`。\n\n- A\n- B\n\n> 引用\n\n```js\nconst x = 1;\n```');
  assert.equal(out().querySelector('h1').textContent, '标题');
  assert.equal(out().querySelector('strong').textContent, '粗体');
  assert.equal(out().querySelectorAll('li').length, 2);
  assert.equal(out().querySelector('blockquote').textContent, '引用');
  assert.match(out().querySelector('pre code').textContent, /const x/);
});

t('HTTP 链接可点且隔离 opener', () => {
  renderMarkdownInto(out(), '[主页](https://example.com/path?q=1)');
  const a = out().querySelector('a');
  assert.equal(a.href, 'https://example.com/path?q=1');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
});

t('危险/相对链接和图片不生成活动元素', () => {
  renderMarkdownInto(out(), '[x](javascript:alert(1)) [y](/local) ![track](https://x/i.png)');
  assert.equal(out().querySelectorAll('a,img').length, 0);
  assert.match(out().textContent, /javascript:/);
  assert.match(out().textContent, /!\[track\]/);
});

t('原始 HTML 永远是文字', () => {
  renderMarkdownInto(out(), '<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
  assert.equal(out().querySelectorAll('script,img').length, 0);
  assert.match(out().textContent, /<script>/);
});

t('重复渲染替换旧内容，CRLF 与空输入不抛', () => {
  renderMarkdownInto(out(), '**旧**');
  renderMarkdownInto(out(), '新\r\n一行');
  assert.ok(!out().textContent.includes('旧'));
  assert.match(out().textContent, /新.*一行/s);
  assert.doesNotThrow(() => renderMarkdownInto(out(), ''));
  assert.equal(out().textContent, '');
});

console.log(`\n${pass} 项通过`);
