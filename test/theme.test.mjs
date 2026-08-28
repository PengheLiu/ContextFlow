// 注入式 UI 的明暗应跟随网页画布，而不是盲目跟随操作系统。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main>paper</main></body></html>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'MutationObserver', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
global.innerWidth = 1280;
global.innerHeight = 800;
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
let systemDark = false;
global.matchMedia = () => ({
  get matches() { return systemDark; },
  addEventListener() {},
});

const { pageTheme, shadowHost } = await import('../src/skill/theme.js');
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('界面主题\n');

await t('系统深色但网页是浅色时，插件保持浅色纸张', () => {
  systemDark = true;
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'rgb(255, 255, 255)';
  assert.equal(pageTheme(), 'light');
});

await t('系统浅色但网页是深色时，插件使用夜间纸张', () => {
  systemDark = false;
  document.body.style.background = 'rgb(24, 23, 21)';
  assert.equal(pageTheme(), 'dark');
});

await t('页面背景变化后，已挂载的 Shadow Host 会同步切换', async () => {
  document.body.style.background = 'rgb(255, 255, 255)';
  const sh = shadowHost('theme-test', '');
  const host = sh.host;
  assert.equal(host.dataset.theme, 'light');
  document.body.style.background = 'rgb(18, 18, 18)';
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.dataset.theme, 'dark');
});

await t('onPageTheme 订阅时立即回调，页面明暗变化时再次通知', async () => {
  document.body.style.background = 'rgb(255, 255, 255)';
  const { onPageTheme } = await import('../src/skill/theme.js');
  const seen = [];
  const off = onPageTheme((tone) => seen.push(tone));
  document.body.style.background = 'rgb(18, 18, 18)';
  await new Promise((r) => setTimeout(r, 20));
  off();
  assert.deepEqual(seen, ['light', 'dark']);
});

console.log(`\n${pass} 项通过`);
