// 浏览器 userscript入口生命周期：第一次展开，之后每次重新执行只切换现有面板。
// 这里故意让 document 保持 loading，覆盖用户连续快速点击、Panel 尚未创建的竞态。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const makeDocument = () => {
  const doc = new EventTarget();
  doc.documentElement = { dataset: {} };
  doc.body = null;
  doc.readyState = 'loading';
  return doc;
};

const store = new Map();
global.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
global.location = { href: 'https://example.com/article' };
global.document = makeDocument();

const { boot } = await import('../src/skill/main.js');

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('userscript入口开合\n');

let app;
t('公开入口第一次启动请求展开，且只创建一个实例', () => {
  app = boot({ initialPanelOpen: true, toggleExisting: true });
  assert.ok(app);
  assert.equal(app.initialPanelOpen, true);
  assert.equal(document.documentElement.dataset.contextflowLoaded, 'toggle');
});

t('Panel 尚未创建时，第二次点击userscript把待启动状态切为收起', () => {
  const duplicate = boot({ initialPanelOpen: true, toggleExisting: true });
  assert.equal(duplicate, null);
  assert.equal(app.initialPanelOpen, false);
});

t('Panel 尚未创建时，第三次点击userscript再切回展开', () => {
  boot({ initialPanelOpen: true, toggleExisting: true });
  assert.equal(app.initialPanelOpen, true);
});

t('Panel 已存在后，userscript本身持续充当展开/收起开关', () => {
  let calls = 0;
  app.panel = {
    open: true,
    toggle(open = !this.open) { this.open = open; calls++; },
  };
  boot({ initialPanelOpen: true, toggleExisting: true });
  assert.equal(app.panel.open, false);
  boot({ initialPanelOpen: true, toggleExisting: true });
  assert.equal(app.panel.open, true);
  assert.equal(calls, 2);
});

t('普通扩展实例仍拒绝重复注入，不会被公开入口事件误切换', () => {
  document = makeDocument();
  const extensionApp = boot();
  let calls = 0;
  extensionApp.panel = { toggle() { calls++; } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(boot({ initialPanelOpen: true, toggleExisting: true }), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(document.documentElement.dataset.contextflowLoaded, '1');
  assert.equal(calls, 0);
});

t('userscript 入口启用首次展开与重复切换选项', () => {
  const entry = readFileSync(new URL('../src/skill/entry.js', import.meta.url), 'utf8');
  assert.match(entry, /boot\(\{\s*initialPanelOpen:\s*true,\s*toggleExisting:\s*true\s*\}\)/);
});

console.log(`\n${pass} 项通过`);
