// AI 回答 Markdown 预览：只允许一小组被动、安全的 DOM 节点。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="out"></div></body>');
for (const k of ['window', 'document', 'HTMLElement', 'Node']) global[k] = dom.window[k];
const { renderMarkdownInto, MARKDOWN_CSS } = await import('../src/skill/markdown-view.js');

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
    // CommonMark consumes punctuation escapes even when this is not a table.
    assert.ok(out().textContent.includes(source.split('\n')[0].replace(/\\\|/g, '|')), source);
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

t('截图中的 Brier loss 块公式及行内括号公式渲染为 MathML，不变成斜体或代码', () => {
  const source = String.raw`布里尔损失：
\[
L_{\text{Brier}}=(q-c)^2
\]
其中，\(q\) 是预测概率，\(c\) 是实际结果。

- 答错时：\(0.9^2=0.81\)。
- 答对时：\((0.9-1)^2=0.01\)。`;
  renderMarkdownInto(out(), source);
  assert.equal(out().querySelectorAll('math').length, 5);
  assert.equal(out().querySelectorAll('.md-math-display').length, 1);
  assert.equal(out().querySelector('math[display="block"] annotation').textContent, String.raw`L_{\text{Brier}}=(q-c)^2`);
  assert.equal(out().querySelectorAll('em,pre').length, 0);
  assert.equal(out().querySelector('.md-math-display').tabIndex, 0);
  assert.equal(source.includes(String.raw`\[`), true, '渲染不修改 Markdown 原文');
});

t('美元、括号、中括号、同行块及 math 围栏均支持公式', () => {
  for (const source of [String.raw`$\frac{a}{b}$`, String.raw`\(\frac{a}{b}\)`,
    String.raw`$$\frac{a}{b}$$`, String.raw`\[\frac{a}{b}\]`,
    '$$\n\\frac{a}{b}\n$$', '```math\n\\frac{a}{b}\n```', String.raw`前文 $$\frac{a}{b}$$ 后文`]) {
    renderMarkdownInto(out(), source);
    assert.equal(out().querySelectorAll('math mfrac').length, 1, source);
    assert.equal(out().querySelector('.md-math-fallback'), null, source);
  }
});

t('矩阵、分段、多行对齐、积分、求和与上下标保留数学结构', () => {
  for (const formula of [String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`f(x)=\begin{cases}x^2 & x>0\\0 & x\leq0\end{cases}`,
    String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
    String.raw`\int_0^1 x^2\,dx=\frac{1}{3}`, String.raw`\sum_{i=1}^{n}q_i^2`]) {
    renderMarkdownInto(out(), `$$\n${formula}\n$$`);
    assert.ok(out().querySelector('math'), formula);
    assert.equal(out().querySelector('.md-math-fallback'), null, formula);
    assert.equal(out().querySelector('annotation').textContent, formula);
  }
});

t('表格、嵌套列表、引用和粗体中的公式使用同一渲染器', () => {
  renderMarkdownInto(out(), '| 指标 | 公式 |\n|---|---|\n| 损失 | $q_i^2$ |\n\n- **值 \\(c_i\\)**\n  - $q_i$\n\n> \\(x^2\\)');
  assert.ok(out().querySelector('td math'));
  assert.ok(out().querySelector('strong math'));
  assert.ok(out().querySelector('ul ul math'));
  assert.ok(out().querySelector('blockquote math'));
});

t('代码围栏、缩进代码与行内代码不解释公式，长围栏与波浪线有效', () => {
  renderMarkdownInto(out(), '`` $q$ \\(c\\) ``\n\n~~~~latex\n$$x^2$$\n~~~~\n\n    $y$\n\n````md\n```\n\\[z\\]\n```\n````');
  assert.equal(out().querySelectorAll('math').length, 0);
  assert.equal(out().querySelectorAll('pre').length, 3);
  assert.equal(out().querySelector('code').textContent, String.raw`$q$ \(c\)`);
  assert.ok(out().querySelector('.language-latex'));
});

t('货币、转义美元和未闭合分隔符不误渲染或吞掉后文', () => {
  for (const source of [String.raw`价格 $5 和 $10。`, String.raw`预算 \$20，普通的 \(未闭合。`,
    '普通 $x 未闭合\n\n后文 **保留**', '\\[\n未闭合\n\n后文 **保留**']) {
    renderMarkdownInto(out(), source);
    assert.equal(out().querySelectorAll('math').length, 0, source);
    assert.match(out().textContent, /价格|预算|后文/);
  }
});

t('错误公式与递归宏只回退该公式，后续内容仍能渲染', () => {
  for (const formula of [String.raw`\frac{`, String.raw`\def\a{\a}\a`, String.raw`\notARealMathCommand{x}`]) {
    renderMarkdownInto(out(), `前文\n\n$$${formula}$$\n\n后文 **保留**\n\n$x^2$`);
    assert.ok(out().querySelector('.md-math-fallback'), formula);
    assert.equal(out().querySelector('strong').textContent, '保留');
    assert.equal(out().querySelectorAll('math').length, 1);
  }
});

t('公式不执行 HTML、外链、图片或自定义属性，也不允许宏污染下一个公式', () => {
  renderMarkdownInto(out(), [String.raw`$\href{javascript:alert(1)}{x}$`,
    String.raw`$\href{https://tracker.example}{x}$`, String.raw`$\includegraphics{https://tracker.example/x}$`,
    String.raw`$\htmlClass{evil}{x}$`, String.raw`$\text{<img src=x onerror=alert(1)>}$`,
    String.raw`$\gdef\evil{x}$`, String.raw`$\evil$`].join('\n\n'));
  assert.equal(out().querySelectorAll('a,img,script,iframe,style,.evil,[onerror],[onclick]').length, 0);
  assert.ok(out().lastElementChild.querySelector('.md-math-fallback'));
});

t('公式大小和数量有界，超过预算时仍保留原文和正文', () => {
  renderMarkdownInto(out(), Array(205).fill('$x$').join(' ') + '\n\n末尾 **保留**');
  assert.equal(out().querySelectorAll('math').length, 200);
  assert.equal(out().querySelectorAll('.md-math-fallback').length, 5);
  assert.equal(out().querySelector('strong').textContent, '保留');
  renderMarkdownInto(out(), '```math\n' + 'x'.repeat(8100) + '\n```\n\n后文');
  assert.ok(out().querySelector('.md-math-fallback'));
  assert.match(out().textContent, /后文/);
});

t('行内与块公式均限制在容器内，长公式可横向滚动', () => {
  for (const mode of ['inline','display']) {
    assert.match(MARKDOWN_CSS, new RegExp(`\\.md \\.md-math-${mode}\\{[^}]*max-width:100%[^}]*overflow-x:auto`));
  }
});

t('CommonMark：六级与 Setext 标题、分隔线、实体、转义及嵌套强调', () => {
  renderMarkdownInto(out(), '标题\n===\n\n副标题\n---\n\n##### 五级\n\n###### 六级\n\n***嵌套*** 与 \\*普通星号\\* &amp; &lt;tag&gt;\n\n---');
  assert.equal(out().querySelector('h1').textContent, '标题');
  assert.equal(out().querySelector('h2').textContent, '副标题');
  assert.ok(out().querySelector('h5')); assert.ok(out().querySelector('h6'));
  assert.ok(out().querySelector('em strong, strong em'));
  assert.match(out().textContent, /\*普通星号\* & <tag>/);
  assert.equal(out().querySelectorAll('hr').length, 1);
});

t('GFM：删除线、任务列表、自动链接与引用式链接', () => {
  renderMarkdownInto(out(), '~~删除~~ https://example.com/path\n\n[文档][ref]\n\n[ref]: https://example.org "说明"\n\n- [ ] 未完成\n- [x] 已完成\n  - [X] 子任务\n\n3) 第三步\n4) 第四步');
  assert.equal(out().querySelector('s').textContent, '删除');
  assert.equal(out().querySelectorAll('a').length, 2);
  assert.equal(out().querySelectorAll('.md-task-checkbox:disabled').length, 3);
  assert.equal(out().querySelectorAll('.md-task-checkbox:checked').length, 2);
  assert.ok(out().querySelector('.md-task-item ul .md-task-checkbox'));
  assert.equal(out().querySelector('ol').start, 3);
});

t('脚注可定位并返回，各次渲染不共享引用目标', () => {
  renderMarkdownInto(out(), '结论[^note]，重复引用[^note]。\n\n[^note]: 说明含 $x^2$ 与 **重点**。');
  const ref = out().querySelector('sup button'), note = out().querySelector('.md-footnotes li');
  assert.equal(out().querySelectorAll('sup button').length, 2);
  assert.ok(note.querySelector('math')); assert.ok(note.querySelector('strong'));
  ref.click(); assert.equal(document.activeElement, note);
  note.querySelector('button').click(); assert.equal(document.activeElement, ref);
  renderMarkdownInto(out(), '新内容');
  assert.equal(out().querySelector('.md-footnotes'), null);
});

t('GitHub 提示块保留嵌套 Markdown，不把原始 HTML 当内容执行', () => {
  for (const type of ['NOTE','TIP','IMPORTANT','WARNING','CAUTION']) {
    renderMarkdownInto(out(), `> [!${type}]\n> **重点** $q$\n>\n> - 第一项\n> - <script>alert(1)</script>`);
    assert.ok(out().querySelector(`.md-alert-${type.toLowerCase()}`));
    assert.ok(out().querySelector('.md-alert-title')); assert.ok(out().querySelector('strong'));
    assert.ok(out().querySelector('math')); assert.equal(out().querySelectorAll('script').length, 0);
  }
});

console.log(`\n${pass} 项通过`);
