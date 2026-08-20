// CORS 白名单匹配的安全回归测试。
// 这是主防线（DESIGN.md §0），一旦放宽，任何网页都能读写全部阅读记录，
// 因此每个用于混淆匹配的构造都要固定住。
import assert from 'node:assert/strict';

// **直接 import 实现**，不再抄一份 —— 抄的那份会让"改了实现忘了改测试"依然全绿。
import { originAllowed } from '../server/origin.mjs';

const allowed = (patterns, origin, any = false) =>
  originAllowed({ allowedOrigins: patterns, allowAnyOrigin: any }, origin);

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



// ---- 浏览器扩展 origin ----
//
// 这是扩展路线的价值所在：token 在 service worker 里、页面碰不到，
// 所以可以关掉 allowAnyOrigin、只白名单一个扩展 id。
const EXT = 'chrome-extension://cgimipjfmopjcaedmgccaodjppdpkfjf';
const PE = [...P, EXT];

t('白名单里的扩展 id 放行', () => assert.equal(allowed(PE, EXT), true));

t('未列入的扩展一律拒绝（哪怕形状合法）', () =>
  assert.equal(allowed(PE, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false));

t('扩展 id 形状不合法则拒绝：长度不对', () =>
  assert.equal(allowed([...P, 'chrome-extension://short'], 'chrome-extension://short'), false));

t('扩展 id 形状不合法则拒绝：超出 a–p 字母表', () => {
  const bad = 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  assert.equal(allowed([...P, bad], bad), false);
});

t('扩展 id 形状不合法则拒绝：含数字', () => {
  const bad = 'chrome-extension://cgimipjfmopjcaedmgccaodjppdpkf1f';
  assert.equal(allowed([...P, bad], bad), false);
});

// 与 'https://*' 那条同构：通配不得成为放开全网的暗门
t("'chrome-extension://*' 不能通配放行任意扩展（回归）", () =>
  assert.equal(allowed([...P, 'chrome-extension://*'], EXT), false));

t('扩展 origin 不受 https 通配影响', () =>
  assert.equal(allowed(['https://*'], EXT), false));

t('allowAnyOrigin 打开时扩展也放行', () => assert.equal(allowed([], EXT, true), true));

t('大小写混合的扩展 id 拒绝（id 只可能是小写）', () => {
  const bad = 'chrome-extension://CGIMIPJFMOPJCAEDMGCCAODJPPDPKFJF';
  assert.equal(allowed([...P, bad], bad), false);
});

console.log(`\n${pass} 项通过`);
