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

t('紧接正文的五级对照表渲染为表头和五行数据，不吞掉后文', () => {
  renderMarkdownInto(out(), `两套体系可以逐级对照：
| 级别 | 本文（世界模型路线） | OpenAI（能力分级） |
|---|---|---|
| L1 | 生成世界 World Generation（离线视频生成） | 聊天机器人 Chatbot |
| L2 | 与世界交互 Interactive World（实时输入） | 推理者 Reasoner |
| L3 | 在世界中行动 Actionable World（如 WAM 输出机器人动作） | 智能体 Agent |
| L4 | 自主世界智能体 Autonomous World Agent（长期目标、自主探索） | 创新者 Innovator |
| L5 | 世界组织者 World Orchestrator（组织多机器人/智能体/人/工具） | 组织者 Organizer |
关键差别有三点。`);
  const table = out().querySelector('table');
  assert.ok(table);
  assert.deepEqual([...table.querySelectorAll('thead th')].map((cell) => cell.textContent),
    ['级别', '本文（世界模型路线）', 'OpenAI（能力分级）']);
  assert.equal(table.querySelectorAll('th[scope="col"]').length, 3);
  assert.equal(table.querySelectorAll('tbody tr').length, 5);
  assert.equal(table.querySelectorAll('tbody td').length, 15);
  assert.match(table.rows[5].cells[2].textContent, /Organizer/);
  assert.deepEqual([...out().children].map((element) => element.tagName), ['P', 'DIV', 'P']);
  assert.equal(out().lastElementChild.textContent, '关键差别有三点。');
  assert.ok(table.parentElement.classList.contains('md-table'));
  assert.equal(table.parentElement.tabIndex, 0);
  assert.equal(table.parentElement.getAttribute('aria-label'), '表格');
});

t('可省略首尾竖线，分隔行决定整列对齐，兼容 CRLF', () => {
  renderMarkdownInto(out(), '左 | 中 | 右\r\n:--- | :---: | ---:\r\nA | B | C');
  const rows = [...out().querySelectorAll('tr')];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual([...row.cells].map((cell) => cell.style.textAlign), ['left', 'center', 'right']);
  }
});

t('转义竖线保留在单元格内，包括行内代码和行尾', () => {
  renderMarkdownInto(out(), [
    String.raw`| 字段\|别名 | 值 |`,
    '| --- | --- |',
    String.raw`| **甲\|乙** | ` + '`a\\|b` |',
    String.raw`甲 | 尾\|`,
    String.raw`| path\\| next |`,
  ].join('\n'));
  const rows = [...out().querySelectorAll('tr')];
  assert.equal(rows.length, 4);
  assert.equal(rows[0].cells[0].textContent, '字段|别名');
  assert.equal(rows[1].cells.length, 2);
  assert.equal(rows[1].cells[0].querySelector('strong').textContent, '甲|乙');
  assert.equal(rows[1].cells[1].querySelector('code').textContent, 'a|b');
  assert.equal(rows[2].cells[1].textContent, '尾|');
  assert.equal(rows[3].cells[1].textContent, 'next');
});

t('空单元格保留，短行补齐，长行按表头列数截断', () => {
  renderMarkdownInto(out(), '| A | B | C |\n|---|---|---|\n| 1 || 3 |\n| 4 |\n| 5 | 6 | 7 | 8 |');
  assert.deepEqual([...out().querySelectorAll('tbody tr')].map((row) =>
    [...row.cells].map((cell) => cell.textContent)), [['1', '', '3'], ['4', '', ''], ['5', '6', '7']]);
});

t('支持只有表头的单列表格', () => {
  renderMarkdownInto(out(), '| 名称 |\n| --- |');
  assert.equal(out().querySelector('thead th')?.textContent, '名称');
  assert.equal(out().querySelectorAll('tbody tr').length, 0);
});

t('无效分隔行、列数不符和普通竖线文本不误判为表格', () => {
  for (const source of [
    '甲 | 乙\n丙 | 丁',
    '| A | B |\n|---|\n| C | D |',
    '| A | B |\n|---|文字|\n| C | D |',
    '| A | B |\n|---||\n| C | D |',
    '标题\n---\n正文',
    String.raw`甲\|乙` + '\n--- | ---',
  ]) {
    renderMarkdownInto(out(), source);
    assert.equal(out().querySelector('table'), null, source);
    assert.ok(out().textContent.includes(source.split('\n')[0]), source);
  }
});

t('表格遇到标题、列表、引用、代码块或空行时结束', () => {
  for (const [suffix, selector] of [
    ['## 标题 | 说明', 'h2'],
    ['- 选项 | 说明', 'ul'],
    ['1. 步骤 | 说明', 'ol'],
    ['> 引用 | 说明', 'blockquote'],
    ['```text\n| A | B |\n|---|---|\n```', 'pre code'],
    ['\n普通 | 文本', 'p'],
  ]) {
    renderMarkdownInto(out(), `| A | B |\n|---|---|\n| C | D |\n${suffix}`);
    assert.equal(out().querySelectorAll('tbody tr').length, 1, suffix);
    assert.ok(out().querySelector(selector), suffix);
  }
});

t('代码块内表格保持原样，空行分隔的多个表格独立渲染', () => {
  const source = '| A | B |\n|---|---|\n| C | D |';
  renderMarkdownInto(out(), '```markdown\n' + source + '\n```\n\n' + source + '\n\n' + source);
  assert.equal(out().querySelector('pre code').textContent, source);
  assert.equal(out().querySelectorAll('table').length, 2);
});

t('表格行内格式复用安全渲染，不放行 HTML、图片或危险链接', () => {
  renderMarkdownInto(out(), [
    '| **字段** | 值 |',
    '|---|---|',
    '| *主页* | [访问](https://example.com/path) |',
    '| `<tag>` | <img src=x onerror=alert(1)><script>alert(1)</script> |',
    '| [x](javascript:alert(1)) | ![track](https://x/i.png) |',
  ].join('\n'));
  const table = out().querySelector('table');
  assert.ok(table);
  assert.equal(table.querySelector('th strong').textContent, '字段');
  assert.equal(table.querySelector('td em').textContent, '主页');
  assert.equal(table.querySelector('td code').textContent, '<tag>');
  assert.equal(table.querySelectorAll('a').length, 1);
  assert.equal(table.querySelector('a').href, 'https://example.com/path');
  assert.equal(table.querySelector('a').rel, 'noopener noreferrer');
  assert.equal(table.querySelectorAll('script,img,[onerror]').length, 0);
  assert.match(table.textContent, /javascript:/);
  assert.match(table.textContent, /<img/);
});

t('重复渲染替换旧内容，CRLF 与空输入不抛', () => {
  renderMarkdownInto(out(), '**旧**');
  renderMarkdownInto(out(), '新\r\n一行');
  assert.ok(!out().textContent.includes('旧'));
  assert.match(out().textContent, /新.*一行/s);
  assert.doesNotThrow(() => renderMarkdownInto(out(), ''));
  assert.equal(out().textContent, '');
});

t('导出的列点支持引文、多段落与嵌套列表，不显示原始 > 或把后续内容拆出记录',()=>{
  renderMarkdownInto(out(),'- > 原文\n\n- 💬 我的想法\n  下一行\n\n  第二段\n  - 子项\n    - 孙项\n\n- **另一个记录**');
  const list=out().querySelector('ul');assert.equal(list.children.length,3);
  assert.equal(list.children[0].querySelector('blockquote').textContent,'原文');
  assert.match(list.children[1].textContent,/下一行.*第二段.*子项.*孙项/s);
  assert.ok(list.children[1].querySelector('ul ul li'));assert.ok(list.children[2].querySelector('strong'));
  assert.equal(out().children.length,1);
});

console.log(`\n${pass} 项通过`);
