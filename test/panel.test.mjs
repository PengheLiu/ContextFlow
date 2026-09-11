// 右侧面板：速览区与异常兜底。
//
// 这个文件的由来：速览的「重新生成」按钮绑了 this.guard(...)，而那是 Settings 上的
// 方法、Panel 根本没有 —— 抄了模式没抄实现。更糟的是它落在**成功路径**上，
// 于是一次真的跑成了的速览被显示成 "速览失败：this.guard is not a function"。
// 点一下那个按钮就会露，但当时没有任何面板测试。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><p>hello</p></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Range', 'getComputedStyle']) {
  global[k] = dom.window[k];
}
global.innerWidth = 1400;
global.innerHeight = 900;
global.addEventListener = dom.window.addEventListener.bind(dom.window);
global.removeEventListener = dom.window.removeEventListener.bind(dom.window);
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { Panel } = await import('../src/skill/panel.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** 最小 handler 集合：只做面板渲染需要的那些 */
function handlers(over = {}) {
  return {
    getItems: () => [],
    getStats: () => ({ position: 0, quote: 0, fuzzy: 0, orphan: 0 }),
    getNote: () => '',
    isOnline: () => true,
    outbox: () => 0,
    positionOf: () => 0,
    isOrphan: () => false,
    colorOf: () => '#ffd60a',
    commentOf: () => '',
    onCommentInput: () => {},
    onCommentChange: () => {},
    getLookups: () => [],
    api: {},
    ...over,
  };
}
const mk = (over) => new Panel(handlers(over));

console.log('右侧面板\n');

await t('构造后四个 tab、速览区和简洁底栏都在', () => {
  const p = mk();
  for (const k of ['translate', 'explain', 'comments', 'note']) {
    assert.ok(p.sh.getElementById(`t-${k}`), `缺 tab ${k}`);
    assert.ok(p.sh.getElementById(`p-${k}`), `缺 pane ${k}`);
  }
  assert.ok(p.sh.getElementById('brief'), '缺速览区');
  assert.equal(p.sh.querySelector('#copyMd .label').textContent, '复制');
  assert.equal(p.sh.querySelector('#downloadMd .label').textContent, '下载');
  assert.equal(p.sh.querySelector('#sync .label').textContent, '同步');
  for (const id of ['copyMd', 'downloadMd', 'sync']) {
    assert.ok(p.sh.querySelector(`#${id} [role=tooltip]`)?.textContent, `${id} 缺可见悬浮说明`);
  }
  const css = p.sh.querySelector('style').textContent;
  assert.match(css, /\.has-tip \.tip\{[^}]*width:230px/);
  assert.match(css, /white-space:normal/);
  assert.match(css, /overflow-wrap:anywhere/);
});

await t('展开/收起共用同一个中点按钮，手势过程中不替换 DOM', () => {
  const p = mk();
  const toggle = p.sh.getElementById('panelToggle');
  assert.ok(toggle.classList.contains('panel-toggle'));
  assert.equal(toggle.parentNode, p.sh, '侧边按钮不能放在 overflow:hidden 的面板内');
  assert.equal(toggle.querySelectorAll('svg').length, 2, '需要分别显示展开与收起箭头');
  assert.match(toggle.querySelector('.toggle-close path').getAttribute('d'), /^m9 /, '展开时收起箭头应向右');
  assert.match(toggle.querySelector('.toggle-open path').getAttribute('d'), /^m15 /, '收起后展开箭头应向左');
  assert.equal(p.sh.getElementById('close'), null, '不能再保留会与展开按钮竞争同一次手势的第二个按钮');
  assert.equal(p.sh.getElementById('grip'), null, '旧展开按钮应由稳定的单按钮替代');
});

await t('同一个侧边按钮连续展开/收起且贴住面板左缘', () => {
  const p = mk();
  p.toggle(false);
  const toggle = p.sh.getElementById('panelToggle');
  assert.equal(toggle.style.right, '0px');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  assert.equal(p.open, true);
  assert.ok(toggle.classList.contains('open'));
  assert.equal(toggle.style.right, `${p.ui.width}px`);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), '收起 ContextFlow');
  toggle.click();
  assert.equal(p.open, false);
  assert.ok(!toggle.classList.contains('open'));
  assert.equal(toggle.style.right, '0px');
  assert.equal(toggle.getAttribute('aria-label'), '展开 ContextFlow');
});

await t('pointerdown 立即切换，移动后的同次 click 不会反向切换', () => {
  let opened = 0;
  const p = mk({ onOpen: () => { opened++; } });
  p.toggle(false);
  const toggle = p.sh.getElementById('panelToggle');
  toggle.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  assert.equal(p.open, true);
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(p.open, true, '指针 click 不应把刚展开的面板又收起');
  assert.equal(opened, 1);
  toggle.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  assert.equal(p.open, false);
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(p.open, false, '指针 click 不应把刚收起的面板又展开');
});

await t('连续二十次收起展开不丢操作', () => {
  const p = mk();
  p.toggle(false);
  const toggle = p.sh.getElementById('panelToggle');
  for (let i = 0; i < 20; i++) {
    toggle.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    assert.equal(p.open, true, `第 ${i + 1} 次展开失败`);
    toggle.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    assert.equal(p.open, false, `第 ${i + 1} 次收起失败`);
  }
});

await t('面板和页面 margin 使用同一时长连续动画', () => {
  const p = mk();
  p.toggle(true);
  const css = p.sh.querySelector('style').textContent;
  assert.match(css, /\.wrap\{[^}]*transition:transform \.26s/s);
  assert.match(document.documentElement.style.transition, /margin-right (?:0)?\.26s/);
});

await t('锚点术语隐藏在 0/0 的悬浮说明里', () => {
  const p = mk({ getStats: () => ({ position: 2, quote: 1, fuzzy: 1, orphan: 0 }),
    getItems: () => [{}, {}, {}, {}] });
  p.renderStatus();
  const stat = p.sh.getElementById('stat');
  assert.match(stat.querySelector('.stat-main').textContent, /已定位 4\/4/);
  const tip = stat.querySelector('[role=tooltip]');
  assert.match(tip.textContent, /精确 2 · 文本匹配 1 · 模糊恢复 1/);
  assert.equal(tip.parentElement, stat);
  assert.doesNotMatch(stat.textContent, /pos|quote|fuzzy/);
  const css = p.sh.querySelector('style').textContent;
  assert.match(css, /\.anchor-stat:hover \.stat-tip/);
  assert.match(css, /\.anchor-stat:focus-visible \.stat-tip/);
});

await t('配置按钮切换后同步更新可见文案与无障碍名称', () => {
  const p = mk();
  p.settings = { load() {} };
  const btn = p.sh.getElementById('cfg');

  p.toggleSettings();
  assert.equal(btn.textContent.trim(), '返回');
  assert.equal(btn.getAttribute('aria-label'), '返回阅读记录');
  assert.equal(btn.title, '返回阅读记录');

  p.toggleSettings();
  assert.equal(btn.textContent.trim(), '配置');
  assert.equal(btn.getAttribute('aria-label'), '配置');
  assert.equal(btn.title, '配置翻译、解释与笔记同步');
});


await t('设置模式切换控制册副标题并暂时收起阅读底栏', () => {
  const p = mk();
  p.settings = { load() {} };
  const wrap = p.sh.getElementById('wrap');
  const footer = p.sh.querySelector('footer');
  const sub = p.sh.getElementById('brandSub');

  p.toggleSettings();
  assert.equal(wrap.classList.contains('settings-mode'), true);
  assert.equal(sub.textContent, 'SETTINGS');
  assert.match(p.sh.querySelector('style').textContent, /\.wrap\.settings-mode > footer\{display:none\}/);
  assert.ok(footer);

  p.toggleSettings();
  assert.equal(wrap.classList.contains('settings-mode'), false);
  assert.equal(sub.textContent, 'READING MARGIN');
});

await t('侧栏批注输入即时通知共享草稿，原位修改也能无重绘地镜像回来', () => {
  const inputs = [], commits = [];
  const p = mk({
    getItems: () => [{ id: 'h-sync', text: '同步原文', color: 'yellow' }],
    commentOf: () => '旧内容',
    onCommentInput: (id, value) => inputs.push([id, value]),
    onCommentChange: (id, value) => commits.push([id, value]),
  });
  p.toggle(true, false); p.select('comments');
  let ta = p.sh.querySelector('[data-id="h-sync"] .cmt .rc-text');
  ta.value = '侧栏正在输入';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(inputs, [['h-sync', '侧栏正在输入']], '共享草稿没有即时收到侧栏输入');
  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(commits, [['h-sync', '侧栏正在输入']]);

  p.updateCommentDraft('h-sync', '原位编辑器的新内容');
  ta = p.sh.querySelector('[data-id="h-sync"] .cmt .rc-text');
  assert.equal(ta.value, '原位编辑器的新内容');
  assert.equal(p.sh.querySelector('[data-id="h-sync"]'), ta.closest('.item'), '镜像时不应重建批注条目');

  p.markCommentEditing('h-sync', true);
  const item = ta.closest('.item');
  assert.ok(item.classList.contains('editing'));
  assert.match(item.querySelector('.edit-state').textContent, /原文旁编辑/);
  p.markCommentEditing('h-sync', false);
  assert.ok(!item.classList.contains('editing'));
  assert.equal(item.querySelector('.item-head .seq').textContent, '原文位置');

  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(commits, [['h-sync', '侧栏正在输入']], '原位镜像应由原位编辑器提交，侧栏不重复保存');
});

await t('总结笔记使用图文编辑器，普通输入仍按原协议自动保存', () => {
  const inputs = [], commits = [];
  const p = mk({
    getNote: () => '原有总结',
    onNoteInput: (value) => inputs.push(value),
    onNoteChange: (value) => commits.push(value),
  });
  p.toggle(true, false); p.select('note');
  const mount = p.sh.getElementById('note');
  const ta = mount.querySelector('.rc-text');
  assert.equal(ta.value, '原有总结');
  assert.match(mount.querySelector('.rc-hint').textContent, /可粘贴截图或图片/);
  ta.value = '带图总结之前的文字';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(inputs, ['带图总结之前的文字']);
  assert.deepEqual(commits, ['带图总结之前的文字']);
});

// ---- 这就是那个 bug ----

await t('速览区有异常兜底（Panel 自己得有 guard，不能只有 Settings 有）', () => {
  const p = mk();
  assert.equal(typeof p.guard, 'function', 'Panel 没有 guard —— 抄了模式没抄实现');
  assert.equal(typeof p.onHandlerError, 'function');
});

await t('渲染成功态并点「重新生成」不抛（原先在这里炸）', () => {
  let asked = null;
  const p = mk({ onSummarize: (fresh) => { asked = fresh; } });
  p.renderBrief({ state: 'ok', text: '这篇讲 X。', retry: true, meta: 'dsh · 2.1s' });
  const btn = p.sh.querySelector('[data-act=rebrief]');
  assert.ok(btn, '成功态没有「重新生成」按钮');
  assert.doesNotThrow(() => btn.click());
  assert.equal(asked, true, '点了按钮却没请求重新生成');
});

await t('handler 抛异常时摊到界面上，不静默', () => {
  const p = mk({ onSummarize: () => { throw new Error('炸了'); } });
  p.renderBrief({ state: 'ok', text: 'x', retry: true });
  p.sh.querySelector('[data-act=rebrief]').click();
  assert.match(p.sh.getElementById('syncmsg').textContent, /炸了/);
});

await t('async handler 的 reject 也接住（否则只剩 unhandledrejection）', async () => {
  const p = mk({ onSummarize: () => Promise.reject(new Error('异步炸')) });
  p.renderBrief({ state: 'ok', text: 'x', retry: true });
  p.sh.querySelector('[data-act=rebrief]').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(p.sh.getElementById('syncmsg').textContent, /异步炸/);
});

// 代码缺陷要说成代码缺陷，别让人去查网络
await t('TypeError 被说明成「界面代码出错」', () => {
  const p = mk({ onSummarize: () => { null.boom(); } });
  p.renderBrief({ state: 'ok', text: 'x', retry: true });
  p.sh.querySelector('[data-act=rebrief]').click();
  assert.match(p.sh.getElementById('syncmsg').textContent, /界面代码出错/);
});

// ---- 速览区的三种状态 ----

await t('运行态给脉动点（进度文字否则读起来像结论）', () => {
  const p = mk();
  p.renderBrief({ state: 'run', text: '正在生成速览…' });
  const el = p.sh.getElementById('brief');
  assert.ok(el.classList.contains('run'));
  assert.ok(el.querySelector('.dot2'), '运行态没有脉动点');
  assert.ok(!el.querySelector('[data-act=rebrief]'), '运行中还给了「重新生成」');
});

await t('失败态标红并保留重试入口', () => {
  const p = mk();
  p.renderBrief({ state: 'err', text: '速览失败：xxx', retry: true, meta: '提示' });
  const el = p.sh.getElementById('brief');
  assert.ok(el.classList.contains('err'));
  assert.ok(el.querySelector('[data-act=rebrief]'), '失败了却不给重试');
});

await t('传 null 清空速览区（CSS 的 :empty 才能把它藏掉）', () => {
  const p = mk();
  p.renderBrief({ state: 'ok', text: 'x' });
  p.renderBrief(null);
  assert.equal(p.sh.getElementById('brief').innerHTML, '');
});

await t('速览文本经过转义，页面标题里的尖括号不会变成标签', () => {
  const p = mk();
  p.renderBrief({ state: 'ok', text: '<img src=x onerror=alert(1)>' });
  const el = p.sh.getElementById('brief');
  assert.equal(el.querySelectorAll('img').length, 0, '速览内容被当成 HTML 执行了');
  assert.match(el.textContent, /<img/);
});


await t('成功速览渲染 Markdown，HTML 仍保持为文字', () => {
  const p = mk();
  p.renderBrief({ state: 'ok', text: '**重点**\n\n- [主页](https://example.com)\n- <img src=x onerror=alert(1)>' });
  const body = p.sh.querySelector('#brief .txt');
  assert.equal(body.querySelector('strong').textContent, '重点');
  assert.equal(body.querySelector('a').href, 'https://example.com/');
  assert.equal(body.querySelectorAll('img').length, 0);
  assert.match(body.textContent, /<img/);
});

await t('运行和错误态不解释 Markdown', () => {
  const p = mk();
  p.renderBrief({ state: 'run', text: '**运行中**' });
  assert.equal(p.sh.querySelectorAll('#brief .txt strong').length, 0);
  assert.equal(p.sh.querySelector('#brief .txt').textContent.includes('**运行中**'), true);
  p.renderBrief({ state: 'err', text: '[失败](https://example.com)' });
  assert.equal(p.sh.querySelectorAll('#brief .txt a').length, 0);
});


await t('解释列表成功答案渲染 Markdown 且不执行 HTML', () => {
  const answer = '**重点**\n\n- [主页](https://example.com)\n- <img src=x onerror=alert(1)>';
  const p = mk({
    getLookups: (kind) => kind === 'explain' ? [{
      id: 'ex-md', action: 'explain', text: 'source', value: answer,
      anchor: { start: 1 }, createdAt: 1, extra: { question: 'Q' },
    }] : [],
  });
  p.toggle(true, false); p.select('explain');
  const el = p.sh.querySelector('[data-id="ex-md"] .ans');
  assert.equal(el.querySelector('strong').textContent, '重点');
  assert.equal(el.querySelector('a').href, 'https://example.com/');
  assert.equal(el.querySelectorAll('img').length, 0);
  assert.match(el.textContent, /<img/);
});

await t('解释的“我的补充”与原文旁面板双向镜像', () => {
  const inputs = [], commits = [];
  const item = {
    id: 'ex-supp', action: 'explain', text: 'source', value: 'AI 答案',
    anchor: { start: 1 }, createdAt: 1, extra: { question: 'Q', supplement: '旧补充' },
  };
  const p = mk({
    getLookups: (kind) => kind === 'explain' ? [item] : [],
    getLookupSupplement: () => item.extra.supplement,
    onLookupSupplementInput: (id, value) => inputs.push([id, value]),
    onLookupSupplementChange: (id, value) => commits.push([id, value]),
  });
  p.toggle(true, false); p.select('explain');
  let ta = p.sh.querySelector('[data-id="ex-supp"] .supp-editor .rc-text');
  assert.equal(ta.value, '旧补充');
  ta.value = '右栏补充';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(inputs, [['ex-supp', '右栏补充']]);
  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(commits, [['ex-supp', '右栏补充']]);

  p.updateLookupSupplement('ex-supp', '原文旁的新补充');
  ta = p.sh.querySelector('[data-id="ex-supp"] .supp-editor .rc-text');
  assert.equal(ta.value, '原文旁的新补充');
  ta.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(commits, [['ex-supp', '右栏补充']], '镜像内容由原文旁面板提交，不应从右栏重复提交');
});

await t('底部任务轮询重绘时，已完成解释在 mousedown 就跳转原文', () => {
  const items = [{
    id: 'done', action: 'explain', text: 'BBH', value: '答案',
    anchor: { start: 1 }, createdAt: 1, extra: { question: 'Q' },
  }, {
    id: 'running', action: 'explain', text: 'EvalPlus', value: '',
    anchor: { start: 2 }, createdAt: 2, extra: { status: 'running', progress: '准备上下文…' },
  }];
  const located = [];
  const p = mk({
    getLookups: (kind) => kind === 'explain' ? items : [],
    onLocate: (id) => located.push(id),
  });
  p.toggle(true, false); p.select('explain');
  const oldItem = p.sh.querySelector('[data-id="done"]');
  oldItem.querySelector('.kind').dispatchEvent(
    new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  oldItem.querySelector('.seq').dispatchEvent(
    new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  const oldSource = oldItem.querySelector('.src');
  oldSource.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  items[1].extra.progress = '正在生成…';
  p.render();
  oldSource.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.deepEqual(located, ['done', 'done', 'done'], '标签、原文位置和引文都应立即跳转且不重复');

  const currentSource = p.sh.querySelector('[data-id="done"] .src');
  currentSource.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
  currentSource.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 }));
  assert.deepEqual(located, ['done', 'done', 'done', 'done', 'done'], '普通鼠标和键盘 click 都应兜底跳转');
});

await t('失锚解释不响应原文定位手势', () => {
  let located = 0;
  const p = mk({
    getLookups: () => [{ id: 'lost', text: 'lost', value: 'answer', createdAt: 1 }],
    isOrphan: () => true,
    onLocate: () => { located++; },
  });
  p.toggle(true, false); p.select('explain');
  const src = p.sh.querySelector('[data-id="lost"] .src');
  src.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  src.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
  src.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 }));
  assert.equal(located, 0);
});

// ---- 打开面板的时刻 ----

await t('恢复上次展开状态时不在构造阶段触发 onOpen；之后手动展开仍通知一次', () => {
  store.set('contextflow:ui', JSON.stringify({ width: 360, mode: 'push', open: true }));
  let n = 0;
  try {
    const p = mk({ onOpen: () => { n++; } });
    assert.equal(p.open, true, '没有恢复已展开状态');
    assert.equal(n, 0, '构造期间触发 onOpen，会在 App.panel 赋值前访问未初始化实例');
    p.toggle(false);
    p.toggle(true);
    assert.equal(n, 1, '初始化完成后再次手动展开应正常通知');
  } finally {
    store.delete('contextflow:ui');
    document.documentElement.style.marginRight = '';
  }
});

await t('从收起变展开时通知一次；已经展开时不重复通知', () => {
  let n = 0;
  const p = mk({ onOpen: () => { n++; } });
  p.toggle(false);
  const base = n;
  p.toggle(true);
  assert.equal(n, base + 1, '展开时没通知');
  p.toggle(true);
  assert.equal(n, base + 1, '已经展开还重复通知了 —— 速览会被重复触发');
});

await t('收起时不通知', () => {
  let n = 0;
  const p = mk({ onOpen: () => { n++; } });
  p.toggle(true);
  const base = n;
  p.toggle(false);
  assert.equal(n, base);
});

// 面板停在别的 tab 上时，角标是"速览已生成"的唯一线索
await t('有速览时「总结」tab 出现角标', () => {
  const p = mk({ getLookups: (k) => (k === 'summary' ? [{ value: '速览内容' }] : []) });
  p.renderStatus();
  assert.ok(p.sh.getElementById('b-note').classList.contains('has-content'));
  assert.equal(p.sh.getElementById('b-note').textContent, '', '状态应由统一的 CSS 圆点表达，不再混用字符图标');
});

await t('没有速览也没有笔记时角标为空', () => {
  const p = mk();
  p.renderStatus();
  assert.equal(p.sh.getElementById('b-note').textContent, '');
  assert.ok(!p.sh.getElementById('b-note').classList.contains('has-content'));
});

console.log(`\n${pass} 项通过`);
