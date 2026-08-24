// 内部评委站静态结构、证据链接与可访问性闸。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const root = resolve('submission/site');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const dom = new JSDOM(html);
const d = dom.window.document;
let pass = 0;
const t = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

console.log('内部评委站\n');

t('恰好一个 h1 与 main', () => {
  assert.equal(d.querySelectorAll('h1').length, 1);
  assert.equal(d.querySelectorAll('main').length, 1);
});

t('核心章节齐全', () => {
  for (const id of ['problem', 'loop', 'proof', 'score', 'test-pages', 'evidence', 'safety', 'install', 'delivery']) {
    assert.ok(d.getElementById(id), `缺少 #${id}`);
  }
});

t('三个本地验收页存在', () => {
  for (const p of ['tests/anchor.html', 'tests/offline.html', 'tests/sync.html']) {
    assert.ok(existsSync(join(root, p)), `缺少 ${p}`);
  }
});

t('所有本地链接和 fragment 可解析', () => {
  for (const a of d.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    assert.ok(href && href !== '#', '发现空链接');
    if (/^https?:/.test(href)) continue;
    if (href.startsWith('#')) assert.ok(d.querySelector(href), `坏 fragment ${href}`);
    else {
      const [path, frag] = href.split('#');
      const target = resolve(root, path);
      assert.ok(existsSync(target), `坏链接 ${href}`);
      if (frag && target.endsWith('.html')) {
        const td = new JSDOM(readFileSync(target, 'utf8')).window.document;
        assert.ok(td.getElementById(frag), `坏 fragment ${href}`);
      }
    }
  }
});

t('无 file URL、空链接或假视频', () => {
  assert.ok(!/file:\/\//i.test(html));
  assert.equal(d.querySelectorAll('video,iframe').length, 0);
  assert.ok(!/["']#["']/.test(html));
});

t('外链具备 rel，图片具备 alt，按钮有名字', () => {
  for (const a of d.querySelectorAll('a[href^="http"]')) assert.match(a.getAttribute('rel') || '', /noreferrer/);
  for (const img of d.querySelectorAll('img')) assert.ok(img.hasAttribute('alt'));
  for (const b of d.querySelectorAll('button')) assert.ok((b.textContent || b.getAttribute('aria-label') || '').trim());
});

t('CSS 含移动断点、reduced motion 与 focus-visible', () => {
  assert.match(css, /@media\(max-width:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});

t('Planned 不得伪装成 verified', () => {
  for (const el of d.querySelectorAll('.chip.planned')) assert.ok(!el.classList.contains('verified'));
  assert.ok(d.querySelectorAll('.chip.verified').length >= 4);
});

t('公开发布脚本显式排除 submission/site', () => {
  const pub = readFileSync(resolve('tools/publish.mjs'), 'utf8');
  assert.match(pub, /INTERNAL_ONLY\s*=\s*\['submission\/site'\]/);
  const dirs = pub.match(/const DIRS = \[([^\]]+)\]/)?.[1] || '';
  const files = pub.match(/const FILES = \[([\s\S]*?)\n\];/)?.[1] || '';
  assert.ok(!dirs.includes('submission/site'));
  assert.ok(!files.includes('submission/site'));
});

console.log(`\n${pass} 项通过`);
