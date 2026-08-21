// buildTextIndex / serializeRange 的真实 DOM 测试。
//
// 为什么必须有这一档：anchor.test.mjs 里的索引全是**合成**的（整段文本映射到单个节点），
// 从未跑过 buildTextIndex。而线上出过的「引文两端各少几个字符」的 bug 恰好就藏在
// 多文本节点 + 空白折叠的偏移映射里 —— 合成索引永远测不出来。
//
// 判定标准只有一条：serializeRange 产出的 exact，必须等于 String(range)
// 在空白归一化后的结果。差一个字符就是错。
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildTextIndex, serializeRange, resolveAnchor, charOffsetOf, boundaryOffset }
  from '../src/core/anchor.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** 把 jsdom 的 window 装进全局，anchor.js 直接用 document/NodeFilter */
function mount(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  return dom.window.document;
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** 在正文里按「可见文本」定位一段，造出跨节点的真实 Range */
function rangeOverText(doc, needle) {
  const walker = doc.createTreeWalker(doc.body, globalThis.NodeFilter.SHOW_TEXT);
  const nodes = [];
  let flat = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: flat.length });
    flat += n.nodeValue;
  }
  const at = flat.indexOf(needle);
  assert.notEqual(at, -1, `测试数据里找不到 ${JSON.stringify(needle)}`);
  const end = at + needle.length;
  const locate = (off) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (off >= nodes[i].start) return { node: nodes[i].node, offset: off - nodes[i].start };
    }
    return { node: nodes[0].node, offset: 0 };
  };
  const a = locate(at), b = locate(end);
  const r = doc.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

/** 核心断言：序列化出的引文必须与选区文本逐字一致 */
function assertFaithful(doc, needle) {
  const index = buildTextIndex(doc.body);
  const range = rangeOverText(doc, needle);
  const a = serializeRange(range, index);
  assert.ok(a, `serializeRange 返回 null（${needle}）`);
  assert.equal(norm(a.exact), norm(String(range)),
    `引文与选区不一致\n       选区=${JSON.stringify(norm(String(range)))}\n       引文=${JSON.stringify(norm(a.exact))}`);
  return { index, a, range };
}

console.log('buildTextIndex + serializeRange 保真性');

t('单段纯文本', () => {
  const doc = mount('<p>Frontier large language models have increasingly evolved into reasoning models.</p>');
  assertFaithful(doc, 'have increasingly evolved');
});

t('跨行内元素（线上截短 bug 的形状）', () => {
  const doc = mount('<p>Attention is <b>all</b> you <i>need</i> for <span><b>sequence</b> transduction</span> models.</p>');
  assertFaithful(doc, 'is all you need for sequence transduction');
});

t('空白密集排版：exact 不得含连续空白', () => {
  const doc = mount(`<p>
      This     sentence   has
             irregular      whitespace
      throughout    its     body.
  </p>`);
  const { a } = assertFaithful(doc, 'sentence   has\n             irregular');
  assert.ok(!/\s\s/.test(a.exact), `exact 含连续空白: ${JSON.stringify(a.exact)}`);
  assert.ok(!a.exact.includes('\n'), 'exact 含换行');
});

t('跨块元素：不得把两段的词粘连', () => {
  const doc = mount('<p>ends here</p><p>starts there</p>');
  const index = buildTextIndex(doc.body);
  assert.ok(!index.text.includes('herestarts'), `跨块粘连: ${JSON.stringify(index.text)}`);
});

t('前后各有 48 字符时 prefix/suffix 应填满', () => {
  const doc = mount(`<p>${'A'.repeat(80)} TARGET ${'B'.repeat(80)}</p>`);
  const { a } = assertFaithful(doc, 'TARGET');
  assert.equal(a.prefix.length, 48);
  assert.equal(a.suffix.length, 48);
});

t('script/style/textarea 内容不进索引', () => {
  const doc = mount('<p>visible</p><script>SECRET_SCRIPT</script>'
    + '<style>.x{}</style><textarea>SECRET_TEXTAREA</textarea>');
  const index = buildTextIndex(doc.body);
  assert.ok(index.text.includes('visible'));
  assert.ok(!index.text.includes('SECRET_SCRIPT'), 'script 混入索引');
  assert.ok(!index.text.includes('SECRET_TEXTAREA'), 'textarea 混入索引');
});

t('本工具自身 UI（[data-contextflow]）不进索引', () => {
  const doc = mount('<p>article body</p><div data-contextflow="toolbar"><button>批注</button></div>');
  const index = buildTextIndex(doc.body);
  assert.ok(index.text.includes('article body'));
  assert.ok(!index.text.includes('批注'), '工具条文字污染索引');
});

console.log('\n真实 DOM 上的往返解析');

t('序列化 → 解析回同一段文字', () => {
  const doc = mount('<p>The client is <b>required</b> to pass this encrypted block back to the provider.</p>');
  const { index, a } = assertFaithful(doc, 'required to pass this encrypted block');
  const res = resolveAnchor(a, index);
  assert.ok(res, '解析失败');
  assert.equal(res.tier, 'position');
  assert.equal(norm(String(res.range)), norm(a.exact));
});

t('页面上方插入内容后仍能解析（降级到 quote）', () => {
  const doc = mount('<p>The client is required to pass this encrypted block back.</p>');
  const { a } = assertFaithful(doc, 'required to pass this encrypted block');

  const extra = doc.createElement('p');
  extra.textContent = 'Newly prepended paragraph that shifts every offset after it.';
  doc.body.prepend(extra);

  const res2 = resolveAnchor(a, buildTextIndex(doc.body));
  assert.ok(res2, '插入内容后失锚');
  assert.equal(res2.tier, 'quote');
  assert.equal(norm(String(res2.range)), norm(a.exact));
});

t('charOffsetOf 与 locate 互为逆运算', () => {
  const doc = mount('<p>alpha <b>beta</b> gamma <i>delta</i> epsilon</p>');
  const index = buildTextIndex(doc.body);
  for (const word of ['beta', 'gamma', 'delta', 'epsilon']) {
    const r = rangeOverText(doc, word);
    const off = charOffsetOf(index, r.startContainer, r.startOffset);
    assert.equal(index.text.slice(off, off + word.length), word,
      `${word}: 偏移 ${off} 处取到 ${JSON.stringify(index.text.slice(off, off + word.length))}`);
  }
});

console.log('\n词边界吸附');

/** 真实 DOM 上：选区落在词中间时，引文应补齐为完整单词 */
function assertSnap(html, needle, expect) {
  const doc = mount(html);
  const index = buildTextIndex(doc.body);
  const a = serializeRange(rangeOverText(doc, needle), index);
  assert.ok(a, 'serializeRange 返回 null');
  assert.equal(norm(a.exact), expect);
  // 吸附后必须仍然包含原选区，否则是扩错了方向
  assert.ok(norm(a.exact).includes(norm(needle)), '吸附结果不含原选区');
}

t('起手偏一个字符 → 补回开头（线上实际案例）', () => {
  assertSnap('<p>traffic to the attacker’s server without any</p>',
    'ttacker’s server', 'attacker’s server');
});

t('两端都在词内 → 两端都补齐', () => {
  assertSnap('<p>we returned the encoded reasoning trace verbatim</p>',
    'coded re', 'encoded reasoning');
});

t('边界已在空白上 → 不动', () => {
  assertSnap('<p>alpha beta gamma delta</p>', 'beta gamma', 'beta gamma');
});

t('连字符不算词字符：选 distillation 不应扩成 anti-distillation', () => {
  assertSnap('<p>it circumvents anti-distillation mechanisms today</p>',
    'distillation', 'distillation');
});

t('撇号不算词字符：选 attacker 不应扩出 ’s', () => {
  assertSnap('<p>the attacker’s server</p>', 'attacker', 'attacker');
});

t('中文不吸附（无空格分词，扩了会连锁吞整句）', () => {
  assertSnap('<p>这些加密块在不同会话之间完全兼容</p>', '加密块在不同', '加密块在不同');
});

t('中英混排：只补英文那侧', () => {
  assertSnap('<p>关于 reasoning traces 的讨论</p>', 'asoning traces', 'reasoning traces');
});

t('snap:false 可关闭', () => {
  const doc = mount('<p>the attacker’s server</p>');
  const index = buildTextIndex(doc.body);
  const a = serializeRange(rangeOverText(doc, 'ttacker'), index, { snap: false });
  assert.equal(a.exact, 'ttacker');
});

t('吸附后仍能往返解析', () => {
  const doc = mount('<p>we returned the encoded reasoning trace verbatim</p>');
  const index = buildTextIndex(doc.body);
  const a = serializeRange(rangeOverText(doc, 'coded re'), index);
  const res = resolveAnchor(a, index);
  assert.ok(res, '解析失败');
  assert.equal(norm(String(res.range)), 'encoded reasoning');
});

// ---- 元素边界（真实拖选会大量产生）----
//
// 这一组的由来：一条整段的翻译记录 anchor 存成了 null，症状是原文上没有标记、
// 面板里也点不动。根因是 nodeSegs 只以**文本节点**为键，而拖选到段尾时
// range.endContainer 往往是 <p> 而不是文本节点 —— 查表拿不到就整条作废。
// 之前所有用例的两端都恰好落在文本节点上，所以一直没暴露。

const PARA = `
  <p id="a">Live credentials, internal hostnames, and specific indicators have been
     redacted or genericized, while the techniques are described exactly as observed
     by <em>Hugging Face</em>.</p>
  <p id="b">Below is an interactive replay of the intrusion.</p>`;

t('三击选段：两端都是元素容器', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const p = doc.getElementById('a');
  const r = doc.createRange();
  r.selectNodeContents(p);              // start=(p,0) end=(p,childNodes.length)
  const a = serializeRange(r, index);
  assert.ok(a, 'anchor 是 null —— 整段选区又失效了');
  assert.equal(norm(a.exact), norm(String(r)));
});

t('拖到段尾：终点是元素容器', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const p = doc.getElementById('a');
  const first = p.firstChild;                       // 文本节点
  const at = first.nodeValue.indexOf('Live');
  const r = doc.createRange();
  r.setStart(first, at);
  r.setEnd(p, p.childNodes.length);                 // ← 元素边界
  const a = serializeRange(r, index);
  assert.ok(a, 'anchor 是 null');
  assert.equal(norm(a.exact), norm(String(r)));
  assert.ok(a.exact.includes('Hugging Face'), '没覆盖到段末的行内元素');
});

t('从段首起拖：起点是元素容器', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const p = doc.getElementById('a');
  const r = doc.createRange();
  r.setStart(p, 0);                                 // ← 元素边界
  const txt = p.firstChild;
  r.setEnd(txt, txt.nodeValue.indexOf('hostnames') + 'hostnames'.length);
  const a = serializeRange(r, index);
  assert.ok(a);
  assert.equal(norm(a.exact), norm(String(r)));
});

t('跨段选择：终点落在下一段的元素边界上', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const pa = doc.getElementById('a');
  const pb = doc.getElementById('b');
  const r = doc.createRange();
  r.setStart(pa.firstChild, pa.firstChild.nodeValue.indexOf('Live'));
  r.setEnd(pb, pb.childNodes.length);
  const a = serializeRange(r, index);
  assert.ok(a);
  assert.ok(a.exact.includes('Live credentials'));
  assert.ok(a.exact.includes('interactive replay'), '没覆盖到第二段');
});

t('整段锚点能解析回原位（原文才会有标记）', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const p = doc.getElementById('a');
  const r = doc.createRange();
  r.selectNodeContents(p);
  const a = serializeRange(r, index);
  const res = resolveAnchor(a, buildTextIndex(doc.body));
  assert.ok(res, '解析失败 —— 面板里点不动、原文没标记');
  assert.equal(norm(String(res.range)), norm(a.exact));
});

t('boundaryOffset：元素起点取其后第一个字符，终点取其前最后一个', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const p = doc.getElementById('a');
  const start = boundaryOffset(index, p, 0, 'start');
  const end = boundaryOffset(index, p, p.childNodes.length, 'end');
  assert.equal(index.text.slice(start, start + 4), 'Live');
  assert.equal(index.text.slice(end - 1, end), '.');
});

t('文本节点仍走原路径（与 charOffsetOf 一致）', () => {
  const doc = mount(PARA);
  const index = buildTextIndex(doc.body);
  const n = doc.getElementById('a').firstChild;
  for (const off of [0, 5, 20]) {
    assert.equal(boundaryOffset(index, n, off, 'start'), charOffsetOf(index, n, off));
  }
});

t('空元素 / 越界不抛异常，返回 null 或合理值', () => {
  const doc = mount('<p id="a">text</p><div id="e"></div>');
  const index = buildTextIndex(doc.body);
  const e = doc.getElementById('e');
  assert.doesNotThrow(() => boundaryOffset(index, e, 0, 'start'));
  assert.doesNotThrow(() => boundaryOffset(index, e, 0, 'end'));
  assert.doesNotThrow(() => boundaryOffset(index, null, 0, 'start'));
  assert.equal(boundaryOffset(index, null, 0, 'start'), null);
});

console.log(`\n${pass} 项通过`);
