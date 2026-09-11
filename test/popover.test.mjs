// 划词浮层的状态机。
//
// jsdom 没有布局，所以拖动/缩放的像素行为测不了；但**显隐机制**和**引文折叠**
// 是纯 DOM 状态，而且刚从 style.display 改成 class 切换 —— 这类改动错了的表现是
// "浮层永远不出现"，必须有东西守着。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>hello</p></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Range', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
global.innerWidth = 1200;
global.innerHeight = 800;
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
// 不能用 dom.window.performance：jsdom 的实现内部会读全局 performance，
// 赋回去就是无限递归（实测栈溢出）。这里只需要一个单调递增的 now。
global.performance = { now: () => Date.now() };
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

const { Popover } = await import('../src/skill/popover.js');
const { CommentPopover } = await import('../src/skill/comment-popover.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const rect = { left: 100, top: 200, bottom: 220, right: 300, width: 200, height: 20 };

console.log('划词浮层\n');

const pop = new Popover({ name: 'tip-test', title: '解释', input: true, submitLabel: '提问' });

await t('初始是关闭的', () => assert.equal(pop.open$, false));

await t('open 后处于打开态（class 切换，不是改 style.display）', () => {
  pop.open(rect, '一段原文');
  assert.equal(pop.open$, true);
  assert.ok(pop.el.classList.contains('on'));
});

await t('close 后回到关闭态', () => {
  pop.close();
  assert.equal(pop.open$, false);
  assert.ok(!pop.el.classList.contains('on'));
});

// 原来是 overflow:hidden 直接截断，用户看到断在词中间的半句话还不知道后面有内容
await t('引文默认收起（clip），真被截断时可点开、可再收起', () => {
  pop.open(rect, '很长的原文'.repeat(40));
  const src = pop.sh.getElementById('src');
  assert.ok(src.classList.contains('clip'), '默认没有收起');
  // jsdom 没有布局，scrollHeight 恒为 0，量不出溢出 —— 手工标上，模拟真被截断
  src.classList.add('clipped');
  pop.toggleSrc();
  assert.ok(src.classList.contains('open') && !src.classList.contains('clip'));
  pop.toggleSrc();
  assert.ok(src.classList.contains('clip'));
  assert.ok(src.classList.contains('clipped'), '收起后应保留 clipped，否则提示会消失');
});

// 上一版这个提示是无条件的 CSS ::after：引文只有一行、根本没截断时也显示
// "点击展开"，那是在撒谎。现在提示与折叠都以实测溢出为条件。
await t('没被截断时不提示展开，点击也不切换', () => {
  pop.open(rect, '短原文');
  const src = pop.sh.getElementById('src');
  assert.ok(!src.classList.contains('clipped'), '没溢出却标成了 clipped');
  pop.toggleSrc();
  assert.ok(!src.classList.contains('open'), '没可展开的内容却展开了，布局会无谓跳动');
});

await t('引文不再被截断成固定长度（长文完整保留，靠折叠而非丢字）', () => {
  const long = 'A'.repeat(600);
  pop.open(rect, long);
  assert.ok(pop.sh.getElementById('src').textContent.includes(long), '原文被截掉了');
});

await t('没有原文时不显示折叠态，也不因点击而抖动', () => {
  pop.open(rect, '');
  const src = pop.sh.getElementById('src');
  assert.ok(!src.classList.contains('clip'));
  pop.toggleSrc();
  assert.ok(!src.classList.contains('open'), '空引文被展开了');
});

await t('重新打开时引文回到收起态（上次展开不该带到新选区）', () => {
  pop.open(rect, '第一段'.repeat(40));
  pop.sh.getElementById('src').classList.add('clipped');
  pop.toggleSrc();
  pop.open(rect, '第二段'.repeat(40));
  assert.ok(pop.sh.getElementById('src').classList.contains('clip'));
});

await t('body / foot 写入与清空', () => {
  pop.body('答案', 'prog').foot('元信息');
  assert.equal(pop.sh.getElementById('b').textContent, '答案');
  assert.equal(pop.sh.getElementById('b').className, 'prog');
  assert.equal(pop.sh.getElementById('f').textContent, '元信息');
  pop.body('');
  assert.equal(pop.sh.getElementById('b').textContent, '');
});


await t('成功答案渲染 Markdown，进度与错误仍是纯文本', () => {
  pop.answer('**重点** · [主页](https://example.com)');
  assert.equal(pop.sh.querySelector('#b strong').textContent, '重点');
  assert.equal(pop.sh.querySelector('#b a').href, 'https://example.com/');
  pop.body('**仍在运行** <img src=x>', 'prog');
  assert.equal(pop.sh.querySelectorAll('#b strong,#b img').length, 0);
  assert.equal(pop.sh.getElementById('b').textContent, '**仍在运行** <img src=x>');
  assert.equal(pop.sh.getElementById('b').className, 'prog');
});

await t('「重新解释」默认隐藏，命中本地缓存时才露出', () => {
  const again = pop.sh.getElementById('again');
  pop.showRefresh(false);
  assert.equal(again.style.display, 'none');
  pop.showRefresh(true);
  assert.equal(again.style.display, 'block');
});

await t('focus 可预填旧问题，无参数时仍清空', () => {
  pop.focus('为什么重要？');
  assert.equal(pop.question(), '为什么重要？');
  assert.notEqual(pop.sh.getElementById('q').style.height, 'auto');
  pop.focus();
  assert.equal(pop.question(), '');
});

await t('提交回调拿到输入框内容', () => {
  let got = null;
  const p2 = new Popover({ name: 'tip-t2', title: 'T', input: true, onSubmit: (v) => { got = v; } });
  p2.open(rect, 'x');
  p2.sh.getElementById('q').value = '  这是问题  ';
  p2.sh.getElementById('go').click();
  assert.equal(got, '这是问题', '没有 trim 或没拿到值');
});

// onSubmit 多是 async：不接住 reject 就只剩一条 unhandledrejection，界面上什么都不显示
await t('提交回调抛错时，错误显示在浮层上而不是静默', async () => {
  const p3 = new Popover({
    name: 'tip-t3', title: 'T', input: true,
    onSubmit: () => Promise.reject(new Error('炸了')),
  });
  p3.open(rect, 'x');
  p3.sh.getElementById('go').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(p3.sh.getElementById('b').textContent, /炸了/);
});

await t('同步抛错也被接住', () => {
  const p4 = new Popover({
    name: 'tip-t4', title: 'T', input: true,
    onSubmit: () => { throw new Error('同步炸'); },
  });
  p4.open(rect, 'x');
  p4.sh.getElementById('go').click();
  assert.match(p4.sh.getElementById('b').textContent, /同步炸/);
});

await t('尺寸与位置写入 localStorage（下次打开沿用）', () => {
  const p5 = new Popover({ name: 'tip-t5', title: 'T' });
  p5.ui = { ...p5.ui, w: 600, h: 400, x: 50, y: 60 };
  p5.open(rect, 'x');
  assert.equal(p5.el.style.width, '600px');
  assert.equal(p5.el.style.height, '400px');
});

// 原先输入框直接贴着卡片下沿（.ask 的 padding 是 `8px 12px 0`，而答案区为空时
// 被 display:none，没人提供底部留白）。现在留白放在 card 上，与最后可见的是谁无关。
await t('底部留白放在卡片上，不依赖最后一个子元素', () => {
  const css = pop.sh.querySelector('style').textContent;
  assert.match(css, /\.card\{[^}]*padding:0 0 11px/, 'card 没有底部留白');
});

await t('带输入框的浮层有最小高度（否则答案出来前又扁又难输入）', () => {
  const css = pop.sh.querySelector('style').textContent;
  assert.match(css, /\.card\.has-input\{min-height:\d+px\}/);
  assert.ok(pop.el.classList.contains('has-input'));
});

await t('翻译浮层不带输入框，也不显示重复的「引用原文」区域', () => {
  const p6 = new Popover({ name: 'tip-t6', title: '翻译', showSource: false });
  assert.ok(!p6.el.classList.contains('has-input'));
  assert.equal(p6.sh.querySelector('.source'), null);
  assert.equal(p6.sh.getElementById('src'), null);
  assert.equal(p6.sh.getElementById('exp'), null);
  // 调用方仍可沿用 open(rect, source) 的统一签名；隐藏引用区时应安全忽略 source。
  p6.open(rect, '不会显示的原文');
  p6.toggleSrc();
  assert.equal(p6.open$, true);
});

await t('解释浮层默认仍保留「引用原文」区域', () => {
  assert.ok(pop.sh.querySelector('.source'));
  assert.ok(pop.sh.getElementById('src'));
  assert.ok(pop.sh.getElementById('exp'));
});

await t('解释浮层的“我的补充”图文编辑区与右栏双向同步', () => {
  const inputs = [], commits = [];
  const explain = new Popover({
    name: 'tip-supplement-test', title: '解释', input: true, supplement: true,
    onSupplementInput: (id, value) => inputs.push([id, value]),
    onSupplementCommit: (id, value) => commits.push([id, value]),
  });
  explain.open(rect, '原文').supplement('ex-1', '旧补充');
  assert.ok(explain.sh.getElementById('supp').classList.contains('on'));
  let ta = explain.sh.querySelector('#suppEditor .rc-text');
  assert.equal(ta.value, '旧补充');
  ta.value = '面板里补充';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(inputs, [['ex-1', '面板里补充']]);
  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(commits, [['ex-1', '面板里补充']]);

  explain.setSupplementValue('ex-1', '右栏改写');
  ta = explain.sh.querySelector('#suppEditor .rc-text');
  assert.equal(ta.value, '右栏改写');
  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(commits, [['ex-1', '面板里补充']], '镜像内容由右栏提交，不应从原文旁重复提交');
  explain.supplement(null);
  assert.ok(!explain.sh.getElementById('supp').classList.contains('on'));
});

await t('答案区为空时给出占位提示，避免大片空白看起来像坏了', () => {
  const css = pop.sh.querySelector('style').textContent;
  assert.match(css, /#b:empty::before\{content:/);
});

await t('每个浮层挂在独立的 shadow host 上，互不干扰', () => {
  const hosts = [...document.documentElement.querySelectorAll('[data-contextflow]')];
  assert.ok(hosts.length >= 5, `只找到 ${hosts.length} 个宿主`);
  assert.equal(new Set(hosts.map((h) => h.getAttribute('data-contextflow'))).size, hosts.length,
    '出现了同名宿主 —— 重复注入会让事件绑到不可见的那一套上');
});

await t('批注浮层在原文旁直接编辑，并即时把输入交给共享状态', () => {
  const inputs = [];
  const comments = new CommentPopover({ onInput: (id, value) => inputs.push([id, value]) });
  comments.open(rect, { id: 'h-1', source: '一段值得记录的原文', value: '旧批注' });
  assert.equal(comments.open$, true);
  assert.equal(comments.sh.getElementById('src').textContent, '「一段值得记录的原文」');
  assert.equal(comments.input.value, '旧批注');
  comments.input.value = '原位写下的新批注';
  comments.input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(inputs, [['h-1', '原位写下的新批注']]);
  assert.match(comments.sh.getElementById('state').textContent, /已同步到右侧栏/);
  comments.close(false);
});

await t('侧栏修改会反向更新当前原位编辑器，不串到其他批注', () => {
  const comments = new CommentPopover();
  comments.open(rect, { id: 'h-2', source: '原文', value: 'A' });
  comments.setValue('other', '不应出现');
  assert.equal(comments.input.value, 'A');
  comments.setValue('h-2', '从侧栏改成 B');
  assert.equal(comments.input.value, '从侧栏改成 B');
  assert.match(comments.sh.getElementById('state').textContent, /已同步侧栏修改/);
  comments.close(false);
});

await t('批注完成会立即提交、关闭，并通知侧栏结束原文旁编辑态', () => {
  const commits = [], closed = [];
  const comments = new CommentPopover({
    onInput: () => {},
    onCommit: (id, value) => commits.push([id, value]),
    onClose: (id) => closed.push(id),
  });
  comments.open(rect, { id: 'h-3', source: '原文', value: '' });
  comments.input.value = '完成的批注';
  comments.input.dispatchEvent(new window.Event('input', { bubbles: true }));
  comments.sh.getElementById('done').click();
  assert.deepEqual(commits, [['h-3', '完成的批注']]);
  assert.deepEqual(closed, ['h-3']);
  assert.equal(comments.open$, false);
});

await t('复用浮层编辑新批注前先提交旧草稿，切换选区不丢字', () => {
  const commits = [], closed = [];
  const comments = new CommentPopover({
    onInput: () => {},
    onCommit: (id, value) => commits.push([id, value]),
    onClose: (id) => closed.push(id),
  });
  comments.open(rect, { id: 'old', source: '旧原文', value: '' });
  comments.input.value = '还没停顿保存的草稿';
  comments.input.dispatchEvent(new window.Event('input', { bubbles: true }));
  comments.open(rect, { id: 'new', source: '新原文', value: '' });
  assert.deepEqual(commits, [['old', '还没停顿保存的草稿']]);
  assert.deepEqual(closed, ['old']);
  assert.equal(comments.id, 'new');
  comments.close(false);
});

console.log(`\n${pass} 项通过`);
