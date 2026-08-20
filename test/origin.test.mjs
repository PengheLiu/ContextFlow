// CORS 白名单匹配的安全回归测试。
// 这是主防线（DESIGN.md §0），一旦放宽，任何网页都能读写全部阅读记录，
// 因此每个用于混淆匹配的构造都要固定住。
import assert from 'node:assert/strict';

// 与 server/index.mjs 中的实现保持一致
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ORIGIN_RE = /^https?:\/\/[a-z0-9._-]+(:\d{1,5})?$/i;
const allowed = (patterns, origin, any = false) => {
  if (any) return true;
  if (!ORIGIN_RE.test(origin)) return false;
  return patterns.some((p) => p === origin
    || (p.includes('*') && new RegExp(`^${p.split('*').map(escapeRe).join('[^./:]*')}$`).test(origin)));
};

const P = ['https://arxiv.org', 'https://*.github.io', 'http://127.0.0.1:7318'];
let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('CORS origin 白名单');

t('精确匹配放行', () => assert.equal(allowed(P, 'https://arxiv.org'), true));
t('端口需一致', () => assert.equal(allowed(P, 'http://127.0.0.1:7319'), false));
t('单段通配放行', () => assert.equal(allowed(P, 'https://lph.github.io'), true));

t('多段不应被单段通配放行（回归）', () =>
  assert.equal(allowed(P, 'https://a.b.github.io'), false));

t('fragment 混淆必须拦住（安全回归）', () =>
  assert.equal(allowed(P, 'https://evil.com#.github.io'), false));

t('path 混淆必须拦住', () =>
  assert.equal(allowed(P, 'https://evil.com/x.github.io'), false));

t('userinfo 混淆必须拦住', () =>
  assert.equal(allowed(P, 'https://evil.com@lph.github.io'), false));

t('未列站点一律拒绝', () => assert.equal(allowed(P, 'https://evil.com'), false));
t('scheme 不匹配则拒绝', () => assert.equal(allowed(P, 'http://arxiv.org'), false));

t("'https://*' 不再是放开全网的暗门（回归）", () =>
  assert.equal(allowed(['https://*'], 'https://evil.com'), false));

t('allowAnyOrigin 显式开启时才全放行', () => {
  assert.equal(allowed(P, 'https://evil.com', false), false);
  assert.equal(allowed(P, 'https://evil.com', true), true);
});

console.log(`\n${pass} 项通过`);
