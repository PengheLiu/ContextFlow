// 思源后端：注入假内核，验证块编排逻辑。
//
// 不连真实思源 —— 那样测试就依赖你开着思源、还会往你的笔记里写垃圾。
// 假内核记录每一次调用，于是可以断言"有没有重复建文档""标题顺序对不对"
// "改了内容走的是 updateBlock 还是又插了一块"这些真正容易错的地方。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cf-sy-'));
process.env.CONTEXTFLOW_DIR = HOME;
const db = await import('../server/db.mjs');
const { syncAll, render } = await import('../server/siyuan.mjs');
const assets = await import('../server/assets.mjs');
const { assetToken } = await import('../src/core/assets.js');

const CFG = {
  siyuan: {
    origin: 'http://127.0.0.1:6806', token: 'fake',
    notebookId: 'nb1', docPathPrefix: '/阅读',
  },
};

/**
 * 假内核。
 *
 * SQL 分支必须**按条件解析**，不能用 st.includes(id) 这种子串匹配 ——
 * 'doc-11'.includes('doc-1') 为真，会让"是否已索引"误判成已索引，
 * 于是索引块根本不写，而测试报出的却是一个看不懂的失败。
 * 马虎的假件不只误报失败，更会误报通过。
 */
function fakeKernel() {
  let seq = 0;
  const calls = [];
  const docsById = new Map(); // docId → { hpath, parentID }
  const idsByHpath = new Map();
  const blocks = new Map();  // blockId → { md, root, type }
  const attrs = new Map();
  const order = [];

  const addDoc = (hpath, parentID = null) => {
    const id = `doc-${++seq}`;
    docsById.set(id, { hpath, parentID });
    const ids = idsByHpath.get(hpath) || [];
    ids.push(id); idsByHpath.set(hpath, ids);
    return id;
  };
  const first = (hpath) => idsByHpath.get(hpath)?.[0];
  const docs = { // 兼容旧测试的 Map-like 读法，但不会覆盖重复 hpath
    get: first,
    has: (hpath) => !!first(hpath),
    keys: () => idsByHpath.keys(),
    values: () => docsById.keys(),
  };
  const rootOf = (id) => (blocks.has(id) ? blocks.get(id).root : id);

  const call = async (path, payload = {}) => {
    calls.push({ path, payload });
    switch (path) {
      case '/api/filetree/getIDsByHPath':
        return [...(idsByHpath.get(payload.path) || [])];
      case '/api/filetree/createDocWithMd': {
        // 真实内核会补齐缺失祖先；最终路径本身每次调用都新建，不是 get-or-create。
        const parts = payload.path.split('/').filter(Boolean);
        let prefix = '', parent = payload.parentID || null;
        for (const part of parts.slice(0, -1)) {
          prefix += `/${part}`;
          parent = first(prefix) || addDoc(prefix, parent);
        }
        return addDoc(payload.path, payload.parentID || parent);
      }
      case '/api/block/insertBlock': {
        const { previousID, parentID, data } = payload;
        if (previousID && !blocks.has(previousID) && !docsById.has(previousID)) {
          throw new Error(`previousID ${previousID} 不存在`);
        }
        const id = `blk-${++seq}`;
        blocks.set(id, { md: data, root: parentID ?? rootOf(previousID),
          type: /^#{1,6}\s/.test(String(data)) ? 'h' : 'p' });
        order.push(id);
        return [{ doOperations: [{ id }] }];
      }
      case '/api/block/updateBlock': {
        if (!blocks.has(payload.id)) throw new Error('块不存在');
        blocks.get(payload.id).md = payload.data;
        return {};
      }
      case '/api/attr/setBlockAttrs':
        attrs.set(payload.id, { ...(attrs.get(payload.id) || {}), ...payload.attrs });
        return {};
      case '/api/query/sql': return query(payload.stmt);
      default: return {};
    }
  };

  const typeOf = (id) => (blocks.has(id) ? blocks.get(id).type : (docsById.has(id) ? 'd' : null));
  function query(st) {
    // 文档创建后 SQL 索引可以延迟；fake 不靠 hpath SQL 暴露刚创建的文档。
    if (/SELECT id FROM blocks/.test(st) && /hpath=/.test(st)) return [];
    const names = st.match(/name IN \(([^)]*)\)/)
      ? st.match(/name IN \(([^)]*)\)/)[1].split(',').map((x) => x.trim().replace(/'/g, ''))
      : (st.match(/name='([^']*)'/) ? [st.match(/name='([^']*)'/)[1]] : null);
    const val = st.match(/value='([^']*)'/)?.[1];
    const root = st.match(/root_id='([^']*)'/)?.[1];
    if (!names) return [];
    const wantType = st.match(/b\.type='([a-z])'/)?.[1] ?? null;
    for (const [bid, a] of attrs) {
      if (root && rootOf(bid) !== root && bid !== root) continue;
      if (wantType && typeOf(bid) !== wantType) continue;
      for (const n of names) {
        if (val === undefined ? Object.hasOwn(a, n) : a[n] === val) return [{ block_id: bid }];
      }
    }
    return [];
  }

  return { call, calls, docs, docsById, idsByHpath, blocks, attrs, order,
    idsAt: (hpath) => [...(idsByHpath.get(hpath) || [])],
    count: (path) => calls.filter((c) => c.path === path).length,
    mdOf: (id) => blocks.get(id)?.md };
}

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const DAY = (d) => new Date(2026, 7, d, 12).getTime();
const ev = (o) => ({
  urlKey: 'arxiv:1', url: 'https://arxiv.org/abs/1', title: 'Stealing Traces',
  action: 'highlight', text: 'sample', value: null,
  anchor: { start: 0 }, createdAt: DAY(19), ...o,
});
const heads = (k) => k.order.map((id) => k.mdOf(id)).filter((m) => m?.startsWith('## '));

console.log('思源后端（假内核）\n');

// ---- 渲染 ----

await t('翻译带原文（斜体，不用引用块）', () =>
  assert.equal(render(ev({ action: 'translate', text: 'Threat model', value: '威胁模型' })),
    '*Threat model*\n威胁模型'));

await t('解释带问题与原文', () =>
  assert.equal(render(ev({ action: 'explain', text: 'T', value: 'A', extra: { question: 'Q' } })),
    '**❓ Q**\n*T*\nA'));

// 真机抓到的 bug：insertBlock 一次只返回一个块 id。渲染成多块时，多出来的块
// 拿不到 id、不在游标链上也不在 synced 表里 —— 实测是解释的原文与答案整段
// 飘到文档末尾，「解释」标题下只剩一行孤零零的问题。
await t('每种事件都只渲染成一个块（真机回归）', () => {
  const cases = [
    ev({ action: 'highlight', text: '原文一段' }),
    ev({ action: 'comment', value: '评论' }),
    ev({ action: 'note', value: '第一段\n\n第二段\n\n第三段' }),
    ev({ action: 'translate', text: 'src', value: '译文' }),
    ev({ action: 'explain', text: 'src', value: '答案\n\n第二段答案', extra: { question: 'Q' } }),
    ev({ action: 'summary', text: '', value: '这篇讲 X。\n\n结论是 Y。' }),
  ];
  for (const c of cases) {
    const md = render(c);
    if (!md) continue;
    assert.ok(!/\n\s*\n/.test(md), `${c.action} 含空行，会被切成多块：${JSON.stringify(md)}`);
    if (md.startsWith('>')) {
      assert.equal(md.split('\n').length, 1,
        `${c.action} 用了引用块又不止一行，后续行会被吞并或另起块：${JSON.stringify(md)}`);
    }
    assert.ok(!md.split('\n').slice(1).some((l) => l.trimStart().startsWith('>')),
      `${c.action} 的非首行以 > 开头，会另起引用块：${JSON.stringify(md)}`);
  }
});

await t('总结不再加「笔记：」前缀（tab 已改名为总结）', () =>
  assert.equal(render(ev({ action: 'note', value: '小结' })), '小结'));

// ---- 首次同步 ----

const K = fakeKernel();

await t('首次同步：建 1 个文章文档 + 1 个日报文档', async () => {
  db.upsertEvents([
    ev({ id: 'tr1', action: 'translate', text: 'Threat model', value: '威胁模型', anchor: { start: 50 } }),
    ev({ id: 'ex1', action: 'explain', text: 'Threat model', value: '定义攻击者能力', extra: { question: '这段在讲什么' }, anchor: { start: 50 } }),
    ev({ id: 'h1', text: 'evolved rapidly', anchor: { start: 10 } }),
    ev({ id: 'c1', action: 'comment', parentId: 'h1', value: '关键假设', anchor: { start: 10 } }),
    ev({ id: 'n1', action: 'note', value: '本文提出一种攻击', anchor: null }),
  ]);
  const r = await syncAll(CFG, { call: K.call });
  assert.equal(r.inserted, 5, `inserted=${r.inserted}`);
  assert.equal(K.count('/api/filetree/createDocWithMd'), 2, '文档数不对');
});


await t('首次同步先建日期再建文章，SQL 延迟时日期仍只有一个 ID', () => {
  const creates = K.calls.filter((c) => c.path === '/api/filetree/createDocWithMd');
  assert.equal(creates[0].payload.path, '/阅读/2026-08-19');
  assert.equal(creates[1].payload.path, '/阅读/2026-08-19/Stealing Traces');
  assert.equal(K.idsAt('/阅读/2026-08-19').length, 1);
  const dayId = K.idsAt('/阅读/2026-08-19')[0];
  const articleId = K.docs.get('/阅读/2026-08-19/Stealing Traces');
  assert.equal(K.docsById.get(articleId).parentID, dayId);
  assert.equal(db.getIdxDoc('/阅读/2026-08-19').docId, dayId);
});

await t('文章正文顶部有可点击原文链接且带受管属性', () => {
  const docId = K.docs.get('/阅读/2026-08-19/Stealing Traces');
  const sourceId = K.order.find((id) => K.attrs.get(id)?.['custom-contextflow-source'] === 'arxiv:1');
  assert.ok(sourceId, '没有来源块');
  assert.equal(K.mdOf(sourceId), '> 来源：<https://arxiv.org/abs/1>');
  assert.equal(K.attrs.get(sourceId)['custom-contextflow-source-url'], 'https://arxiv.org/abs/1');
  assert.equal(K.attrs.get(docId)['custom-contextflow-url'], 'https://arxiv.org/abs/1');
  const firstHead = K.order.findIndex((id) => K.mdOf(id)?.startsWith('## '));
  assert.ok(K.order.indexOf(sourceId) < firstHead, '来源链接应排在分类标题前');
});

await t('文章文档建在 /阅读/<首次阅读日>/<标题> 下', () =>
  assert.ok(K.docs.has('/阅读/2026-08-19/Stealing Traces'), [...K.docs.keys()].join()));

await t('日报文档按最早那天命名，不是同步当天', () =>
  assert.ok(K.docs.has('/阅读/2026-08-19'), [...K.docs.keys()].join()));

await t('四个分类标题齐全且顺序为 翻译 解释 批注 总结', () =>
  assert.deepEqual(heads(K), ['## 翻译', '## 解释', '## 批注', '## 总结']));

await t('文档打了 urlkey 属性（本地库丢了能反查）', () => {
  const docId = K.docs.get('/阅读/2026-08-19/Stealing Traces');
  assert.equal(K.attrs.get(docId)?.['custom-contextflow-urlkey'], 'arxiv:1');
});

await t('日报里是指向文章文档的链接，不是正文', () => {
  const docId = K.docs.get('/阅读/2026-08-19/Stealing Traces');
  const link = K.order.map((i) => K.mdOf(i)).find((m) => m?.includes('siyuan://blocks/'));
  assert.ok(link?.includes(docId), `link=${link}`);
  assert.ok(!K.order.some((i) => K.mdOf(i)?.includes('威胁模型') && K.mdOf(i).startsWith('- ')));
});

// ---- 幂等 ----

await t('再同步一次：一次内核写操作都不发生', async () => {
  const before = { doc: K.count('/api/filetree/createDocWithMd'), ins: K.count('/api/block/insertBlock') };
  const r = await syncAll(CFG, { call: K.call });
  assert.equal(r.inserted, 0);
  assert.equal(r.updated, 0);
  assert.equal(K.count('/api/filetree/createDocWithMd'), before.doc, '又建了文档');
  assert.equal(K.count('/api/block/insertBlock'), before.ins, '又插了块');
});


await t('日期目录索引被删后，文章无改动的同步也会自动补回', async () => {
  const idx = [...K.attrs.entries()].find(([, a]) => a['custom-contextflow-idx'] === 'arxiv:1');
  assert.ok(idx, '测试前没有索引块');
  K.attrs.delete(idx[0]); K.blocks.delete(idx[0]);
  const before = K.blocks.size;
  const r = await syncAll(CFG, { call: K.call, urlKey: 'arxiv:1' });
  assert.equal(r.inserted, 0); assert.equal(r.updated, 0);
  assert.equal(r.details[0].indexChanged, true);
  assert.equal(K.blocks.size, before + 1);
  assert.ok([...K.attrs.values()].some((a) => a['custom-contextflow-idx'] === 'arxiv:1'));
});

// ---- 跨天：用户报告的核心问题 ----

await t('第二天的新记录进**同一个文档**，不新建文章文档', async () => {
  const before = K.count('/api/filetree/createDocWithMd');
  db.upsertEvents([ev({
    id: 'ex2', action: 'explain', text: 'Ethical', value: '伦理一节',
    extra: { question: '啥意思' }, anchor: { start: 900 }, createdAt: DAY(20),
  })]);
  const r = await syncAll(CFG, { call: K.call });
  assert.equal(r.inserted, 1);
  assert.equal(K.count('/api/filetree/createDocWithMd'), before, '为第二天又建了文档');
  assert.ok(K.docs.has('/阅读/2026-08-19/Stealing Traces'),
    '跨天继续读后文章被搬离首次阅读日目录');
  assert.ok(!K.docs.has('/阅读/2026-08-20/Stealing Traces'),
    '第二天新建了另一份文章文档');
});

await t('追加内容没有重复建「解释」标题', () =>
  assert.equal(heads(K).filter((h) => h === '## 解释').length, 1));

// ---- 改动回写 ----

await t('改了总结走 updateBlock 原地改，不再插块', async () => {
  const insBefore = K.count('/api/block/insertBlock');
  db.upsertEvents([ev({ id: 'n1', action: 'note', value: '改稿：攻击面在推理痕迹', anchor: null })]);
  const r = await syncAll(CFG, { call: K.call });
  assert.equal(r.updated, 1, `updated=${r.updated}`);
  assert.equal(r.inserted, 0);
  assert.equal(K.count('/api/block/insertBlock'), insBefore, '又插了一块，笔记里会有两个版本');
  assert.equal(K.count('/api/block/updateBlock'), 1);
});

await t('改动后的内容确实写进了那个块', () => {
  const hit = K.order.find((i) => K.mdOf(i)?.includes('改稿：攻击面在推理痕迹'));
  assert.ok(hit, '没找到改写后的块');
});

await t('块被用户手工删掉时，退回插入而不是抛错', async () => {
  const ref = db.eventsForArticle('arxiv:1', 'siyuan').find((e) => e.id === 'n1').syncedRef;
  K.blocks.delete(ref);                                   // 模拟用户在思源里删了这块
  db.upsertEvents([ev({ id: 'n1', action: 'note', value: '再改一次', anchor: null })]);
  const r = await syncAll(CFG, { call: K.call });
  assert.equal(r.inserted, 1, '没有退回插入');
  assert.equal(r.updated, 0);
});

// ---- 本地库丢失后的恢复 ----

await t('artdoc 丢了靠块属性反查，不重复建文档', async () => {
  const before = K.count('/api/filetree/createDocWithMd');
  const raw = db.open();
  raw.exec("DELETE FROM artdoc WHERE backend='siyuan'");
  db.upsertEvents([ev({ id: 'h9', text: 'new span', anchor: { start: 700 } })]);
  await syncAll(CFG, { call: K.call });
  assert.equal(K.count('/api/filetree/createDocWithMd'), before, '重复建了文档');
});

// 真机抓到的 bug：按天汇总时代这个属性打在**日报里的文章标题块**上。
// 反查不限定 b.type='d' 就会把标题块当文档，再用 parentID 往里插 ——
// 思源报 "heading is a leaf block and cannot have children"。
await t('旧属性挂在标题块上时不被当成文章文档（真机回归）', async () => {
  const K2 = fakeKernel();
  // 造一个旧世界：日报文档里有个文章标题块，带着旧属性
  const dayDoc = await K2.call('/api/filetree/createDocWithMd',
    { notebook: 'nb1', path: '/阅读/2026-08-19', markdown: '' });
  const legacy = await K2.call('/api/block/insertBlock',
    { dataType: 'markdown', data: '## 老的文章标题', parentID: dayDoc });
  const legacyId = legacy[0].doOperations[0].id;
  await K2.call('/api/attr/setBlockAttrs',
    { id: legacyId, attrs: { 'custom-ctxit-urlkey': 'arxiv:legacy' } });

  db.upsertEvents([ev({
    id: 'lg1', urlKey: 'arxiv:legacy', title: '老文章', action: 'note',
    value: '内容', anchor: null, createdAt: DAY(19),
  })]);
  const r = await syncAll(CFG, { call: K2.call, urlKey: 'arxiv:legacy' });
  assert.equal(r.inserted, 1);
  assert.notEqual(r.docs[0], legacyId, '把标题块当成文档了');
  assert.equal(K2.blocks.get(legacyId).md, '## 老的文章标题', '往旧标题块里写了东西');
});

// ---- 同名文章 ----

await t('同名不同文章不会挤进同一个文档', async () => {
  db.upsertEvents([ev({
    id: 'dup1', urlKey: 'arxiv:2', url: 'https://arxiv.org/abs/2',
    title: 'Stealing Traces', action: 'note', value: '另一篇同名文章', anchor: null,
    createdAt: DAY(21),
  })]);
  await syncAll(CFG, { call: K.call });
  const paths = [...K.docs.keys()].filter((p) => p.includes('/Stealing Traces'));
  assert.equal(paths.length, 2, `同名文档没被区分：${paths.join(' | ')}`);
  assert.ok(paths.some((p) => p.startsWith('/阅读/2026-08-19/')));
  assert.ok(paths.some((p) => p.startsWith('/阅读/2026-08-21/')),
    `第二篇应归 08-21：${paths.join(' | ')}`);
});

// ---- 未配置 ----

await t('未配置 token 且未注入 call 时报可操作的错', async () => {
  await assert.rejects(() => syncAll({ siyuan: { ...CFG.siyuan, token: '' } }), /未配置 siyuan\.token/);
});

await t('含图片的记录先上传思源资源，再把内部引用改写为 assets 路径', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('siyuan-image')]);
  const assetId = createHash('sha256').update(png).digest('hex');
  assets.saveAsset({ id: assetId, mime: 'image/png', name: 'figure.png', data: png.toString('base64') });
  db.upsertEvents([ev({ id: 'sy-img', urlKey: 'siyuan:image', title: '图文解释', action: 'explain',
    text: 'figure', value: 'AI 答案', extra: { question: '图里是什么', supplement: assetToken(assetId, '原文图') } })]);
  const K3 = fakeKernel(); let uploaded = 0;
  K3.call.uploadAsset = async (asset) => { uploaded++; return `assets/${asset.id}.png`; };
  await syncAll(CFG, { call: K3.call, urlKey: 'siyuan:image' });
  assert.equal(uploaded, 1);
  assert.ok(K3.order.map((id) => K3.mdOf(id))
    .some((md) => md?.includes(`![原文图](assets/${assetId}.png)`)));
});

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} 项通过`);
