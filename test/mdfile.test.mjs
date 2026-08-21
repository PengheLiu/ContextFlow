// 文件型同步后端：真实读写临时目录，走完整链路。
//
// 这一层此前零测试覆盖，而它直接写进用户的 Obsidian vault。要钉住的是
// 用户明确提出的三件事：四类都同步、每类一个标题、同一篇永远进同一个文件。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cf-md-home-'));
process.env.CONTEXTFLOW_DIR = HOME;
const db = await import('../server/db.mjs');
const { syncAll, render } = await import('../server/mdfile.mjs');

const VAULT = mkdtempSync(join(tmpdir(), 'cf-md-vault-'));
const CFG = { backend: 'obsidian', root: VAULT, folder: 'Reading' };
const DIR = join(VAULT, 'Reading');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const DAY = (d) => new Date(2026, 7, d, 12).getTime();
const ev = (o) => ({
  urlKey: 'arxiv:2608.09867', url: 'https://arxiv.org/abs/2608.09867',
  title: 'Stealing Reasoning Traces', action: 'highlight',
  text: 'sample', value: null, anchor: { start: 0 }, createdAt: DAY(19), ...o,
});
const read = (n) => readFileSync(join(DIR, n), 'utf8');
const files = () => readdirSync(DIR).sort();
const ART = 'Stealing Reasoning Traces.md';

console.log('文件型同步后端\n');

// ---- 渲染 ----

await t('翻译带原文引用（脱离网页也读得懂）', () => {
  const md = render(ev({ action: 'translate', text: 'Threat model', value: '威胁模型' }));
  assert.match(md, /^> Threat model\n威胁模型$/);
});

await t('解释带问题 + 原文引用', () => {
  const md = render(ev({
    action: 'explain', text: 'Threat model', value: '这一节定义攻击者能力',
    extra: { question: '这段在讲什么' },
  }));
  assert.match(md, /\*\*❓ 这段在讲什么\*\*\n> Threat model\n这一节定义攻击者能力/);
});

await t('解释没填问题时给默认问法', () =>
  assert.match(render(ev({ action: 'explain', text: 'x', value: 'y', extra: { question: '' } })),
    /\*\*❓ 这段在讲什么\*\*/));

await t('空值渲染成空串，不写出孤零零的标记', () => {
  assert.equal(render(ev({ action: 'comment', value: '' })), '');
  assert.equal(render(ev({ action: 'translate', text: 'a', value: '  ' })), '');
});

// ---- 首次同步 ----

await t('首次同步：按标题建文件，四类各一个标题', async () => {
  db.upsertEvents([
    ev({ id: 'tr1', action: 'translate', text: 'Threat model', value: '威胁模型', anchor: { start: 50 } }),
    ev({ id: 'ex1', action: 'explain', text: 'Threat model', value: '定义攻击者能力', extra: { question: '这段在讲什么' }, anchor: { start: 50 } }),
    ev({ id: 'h1', text: 'increasingly evolved', anchor: { start: 10 } }),
    ev({ id: 'c1', action: 'comment', parentId: 'h1', value: '这里说的演化指能力增强', anchor: { start: 10 } }),
    ev({ id: 'n1', action: 'note', value: '本文提出一种窃取推理痕迹的攻击', anchor: null }),
  ]);
  const r = await syncAll(CFG);
  assert.equal(r.inserted, 5, `写入 ${r.inserted} 块`);
  const md = read(ART);
  for (const h of ['## 翻译', '## 解释', '## 批注', '## 总结']) {
    assert.ok(md.includes(h), `缺标题 ${h}`);
  }
});

// 速览是机器生成的，笔记里给它独立标题 —— 和用户自己写的「总结」摆在同一个
// 标题下会分不清谁的想法
await t('速览落在独立的「速览」标题下，且排在最前', async () => {
  db.upsertEvents([ev({
    id: 'sm1', action: 'summary', text: '', anchor: null,
    value: '这篇讲一种通过公开 API 反推推理痕迹的攻击。',
  })]);
  const r = await syncAll(CFG);
  assert.ok(r.inserted >= 1);
  const md = read(ART);
  assert.ok(md.includes('## 速览'), '没有速览标题');
  const seg = md.slice(md.indexOf('## 速览'), md.indexOf('## 翻译'));
  assert.ok(seg.includes('反推推理痕迹'), '速览没落在自己的标题下');
  assert.ok(md.indexOf('## 速览') < md.indexOf('## 总结'), '速览应排在总结之前');
});

await t('速览与用户自己写的总结互不干扰', () => {
  const md = read(ART);
  const brief = md.slice(md.indexOf('## 速览'), md.indexOf('## 翻译'));
  const note = md.slice(md.indexOf('## 总结'));
  assert.ok(!brief.includes('重写：只剩一句'), '用户的总结混进了速览');
  assert.ok(!note.includes('反推推理痕迹'), '速览混进了用户的总结');
});

await t('四个标题的顺序是 翻译 解释 批注 总结', () => {
  const md = read(ART);
  const at = (h) => md.indexOf(h);
  assert.ok(at('## 翻译') < at('## 解释'), '翻译应在解释前');
  assert.ok(at('## 解释') < at('## 批注'), '解释应在批注前');
  assert.ok(at('## 批注') < at('## 总结'), '批注应在总结前');
});

await t('评论紧跟它的高亮', () => {
  const md = read(ART);
  assert.ok(md.indexOf('> increasingly evolved') < md.indexOf('💬 这里说的演化'));
});

await t('日报里生成索引链接（不是正文）', () => {
  const idx = read('2026-08-19.md');
  assert.match(idx, /- \[\[Stealing Reasoning Traces\]\] <!-- cf:idx arxiv:2608\.09867 -->/);
  assert.ok(!idx.includes('威胁模型'), '正文不该出现在日报里');
});

await t('只有两个文件：正文 + 日报', () =>
  assert.deepEqual(files(), ['2026-08-19.md', ART]));

// ---- 幂等 ----

await t('再同步一次：不写盘、不重复', async () => {
  const before = read(ART);
  const r = await syncAll(CFG);
  assert.equal(r.inserted, 0);
  assert.equal(r.updated, 0);
  assert.equal(read(ART), before, '文件内容被改动了');
});

await t('日报索引不重复追加', () => {
  const idx = read('2026-08-19.md');
  assert.equal(idx.split('cf:idx').length - 1, 1);
});

// ---- 跨天追加：用户报告的核心问题 ----

await t('第二天的新记录追加进**同一个文件**，不新建 2026-08-20.md 正文', async () => {
  db.upsertEvents([
    ev({ id: 'ex2', action: 'explain', text: 'Ethical Considerations', value: '伦理考量一节', extra: { question: '啥意思' }, anchor: { start: 900 }, createdAt: DAY(20) }),
  ]);
  const r = await syncAll(CFG);
  assert.equal(r.inserted, 1);
  assert.deepEqual(files(), ['2026-08-19.md', ART], `多出了文件：${files()}`);
  assert.ok(read(ART).includes('伦理考量一节'));
});

await t('追加的解释进了「解释」标题下，没另起一节', () => {
  const md = read(ART);
  assert.equal(md.split('## 解释').length - 1, 1, '出现了两个「解释」标题');
  const seg = md.slice(md.indexOf('## 解释'), md.indexOf('## 批注'));
  assert.ok(seg.includes('伦理考量一节'), '新解释没落在解释节里');
});

await t('同一篇改了标题也不会换文件（落点由 artdoc 钉死）', async () => {
  db.upsertEvents([ev({ id: 'h2', text: 'another span', title: '标题被网站改了', anchor: { start: 300 } })]);
  await syncAll(CFG);
  assert.deepEqual(files(), ['2026-08-19.md', ART]);
});

// ---- 改动回写 ----

await t('改了总结 → 原地替换，不追加第二份', async () => {
  db.upsertEvents([ev({ id: 'n1', action: 'note', value: '改稿：本文的攻击面在推理痕迹泄漏', anchor: null })]);
  const r = await syncAll(CFG);
  assert.equal(r.updated, 1, `updated=${r.updated}`);
  assert.equal(r.inserted, 0);
  const md = read(ART);
  assert.ok(md.includes('改稿：本文的攻击面'), '新总结没写进去');
  assert.ok(!md.includes('本文提出一种窃取推理痕迹的攻击'), '旧总结还在，成了两个版本');
});

// 这是上面那条测试漏掉的情形：块内容自己含空行，用"向上找空行"界定块范围
// 会只替换掉最后一段，把前面的段落留成孤儿。
await t('多段总结原地替换：旧的每一段都不残留', async () => {
  db.upsertEvents([ev({
    id: 'n1', action: 'note', anchor: null,
    value: '第一段：核心贡献。\n\n第二段：待验证的点。\n\n第三段：与相关工作的差异。',
  })]);
  await syncAll(CFG);
  let md = read(ART);
  for (const seg of ['第一段：核心贡献。', '第二段：待验证的点。', '第三段：与相关工作的差异。']) {
    assert.ok(md.includes(seg), `多段总结缺 ${seg}`);
  }

  db.upsertEvents([ev({ id: 'n1', action: 'note', value: '重写：只剩一句。', anchor: null })]);
  const r = await syncAll(CFG);
  assert.equal(r.updated, 1);
  md = read(ART);
  assert.ok(md.includes('重写：只剩一句。'));
  for (const seg of ['第一段：核心贡献。', '第二段：待验证的点。', '第三段：与相关工作的差异。']) {
    assert.ok(!md.includes(seg), `旧段落残留：${seg}`);
  }
  assert.equal(md.split('cf:n1').length - 1, 1, '标记出现了多次');
});

await t('多段解释（答案含空行）同样能整块替换', async () => {
  db.upsertEvents([ev({
    id: 'ml1', action: 'explain', text: 'Prompt Injections', anchor: { start: 400 },
    extra: { question: '怎么防' }, value: '两种思路：\n\n1. 输入侧过滤\n\n2. 输出侧校验',
  })]);
  await syncAll(CFG);
  assert.ok(read(ART).includes('2. 输出侧校验'));

  db.upsertEvents([ev({
    id: 'ml1', action: 'explain', text: 'Prompt Injections', anchor: { start: 400 },
    extra: { question: '怎么防' }, value: '换个答案',
  })]);
  await syncAll(CFG);
  const md = read(ART);
  assert.ok(md.includes('换个答案'));
  assert.ok(!md.includes('输入侧过滤'), '旧答案残留');
});

await t('改了评论 → 同样原地替换', async () => {
  db.upsertEvents([ev({ id: 'c1', action: 'comment', parentId: 'h1', value: '修正后的评论', anchor: { start: 10 } })]);
  await syncAll(CFG);
  const md = read(ART);
  assert.ok(md.includes('修正后的评论'));
  assert.ok(!md.includes('这里说的演化指能力增强'));
});

// ---- DB 丢失后的恢复 ----

await t('DB 里的同步记录丢了，靠文件标记也不重复写', async () => {
  const before = read(ART);
  const raw = db.open();
  raw.exec("DELETE FROM synced WHERE backend='obsidian'");
  raw.exec('UPDATE events SET dirty = 0');
  const r = await syncAll(CFG);
  assert.equal(r.inserted, 0, `重复写了 ${r.inserted} 块`);
  assert.equal(read(ART), before);
});

// ---- 多文章 ----

await t('第二篇文章各写各的文件', async () => {
  db.upsertEvents([ev({
    id: 'b1', urlKey: 'blog:kv', url: 'https://ex.com/kv', title: 'KV Cache Compaction',
    action: 'note', value: '压缩策略小结', anchor: null, createdAt: DAY(20),
  })]);
  await syncAll(CFG);
  assert.ok(files().includes('KV Cache Compaction.md'));
  assert.ok(read('2026-08-20.md').includes('cf:idx blog:kv'));
});

// ---- 后端差异与安全 ----

await t('markdown 后端用相对链接（wikilink 只有 Obsidian 认）', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'cf-md-plain-'));
  db.upsertEvents([ev({
    id: 'p1', urlKey: 'blog:plain', title: 'Plain Target', action: 'note',
    value: '降级方案', anchor: null, createdAt: DAY(21),
  })]);
  await syncAll({ backend: 'markdown', root: dir2, folder: '' });
  const idx = readFileSync(join(dir2, '2026-08-21.md'), 'utf8');
  assert.match(idx, /- \[Plain Target\]\(Plain%20Target\.md\)/);
  rmSync(dir2, { recursive: true, force: true });
});

await t('folder 里的 ../ 被拒（不能写到 vault 外面）', async () => {
  await assert.rejects(() => syncAll({ backend: 'obsidian', root: VAULT, folder: '../../etc' }),
    /越出根目录/);
});

await t('未配置目录时报可操作的错', async () => {
  await assert.rejects(() => syncAll({ backend: 'obsidian', root: '', folder: 'x' }),
    /未配置 Obsidian vault/);
});

await t('标题含非法字符时文件名安全', async () => {
  db.upsertEvents([ev({
    id: 'z1', urlKey: 'blog:slash', title: 'A/B: Testing?', action: 'note',
    value: 'x', anchor: null, createdAt: DAY(22),
  })]);
  await syncAll(CFG);
  const f = files().find((n) => n.startsWith('A B'));
  assert.ok(f, `没找到清理后的文件名：${files()}`);
  assert.ok(statSync(join(DIR, f)).isFile());
});

await t('只同步指定文章时不碰其他文件', async () => {
  db.upsertEvents([
    ev({ id: 'only1', action: 'note', value: '只同步这篇', anchor: null }),
    ev({ id: 'other1', urlKey: 'blog:kv', action: 'note', value: '不该被写', anchor: null, createdAt: DAY(20) }),
  ]);
  const r = await syncAll(CFG, { urlKey: 'arxiv:2608.09867' });
  assert.equal(r.articles, 1);
  assert.ok(!read('KV Cache Compaction.md').includes('不该被写'));
});

rmSync(HOME, { recursive: true, force: true });
rmSync(VAULT, { recursive: true, force: true });
console.log(`\n${pass} 项通过`);
