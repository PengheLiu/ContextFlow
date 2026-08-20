// 传输层 seam。
//
// 整个客户端的网络访问收敛在 api.js 的 call() 一个函数上，扩展载体靠替换它把请求
// 转给 service worker（token 只在 SW 里）。这一层错了的症状是"扩展装上了但一直连不上
// 服务"，而且从界面上看不出是传输层没换 —— 所以要测。
import assert from 'node:assert/strict';

// api.js 在模块顶层就会摸 localStorage（键迁移 + outbox），先备好
const store = new Map();
global.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.fetch = async () => { throw new Error('不该走到默认 fetch'); };

const api = await import('../src/core/api.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('传输层 seam\n');

await t('替换后请求走新通道，不再碰 fetch', async () => {
  const seen = [];
  api.setTransport(async (path, init) => {
    seen.push({ path, method: init?.method });
    return { status: 200, body: { ok: true, stats: {} } };
  });
  const r = await api.health();
  assert.deepEqual(seen, [{ path: '/health', method: undefined }]);
  assert.equal(r.ok, true);
});

await t('路径与请求体如实传给传输层', async () => {
  let got = null;
  api.setTransport(async (path, init) => { got = { path, init }; return { status: 200, body: {} }; });
  await api.translate('Threat model', undefined, 'art:1', 120);
  assert.equal(got.path, '/translate');
  assert.equal(got.init.method, 'POST');
  const body = JSON.parse(got.init.body);
  assert.equal(body.text, 'Threat model');
  assert.equal(body.urlKey, 'art:1');
  assert.equal(body.offset, 120);
});

await t('非 2xx 抛错，并带上 status 与服务端 code', async () => {
  api.setTransport(async () => ({ status: 503, body: { error: '未配置 API key', code: 'NO_API_KEY' } }));
  await assert.rejects(() => api.health(), (e) => {
    assert.equal(e.message, '未配置 API key');
    assert.equal(e.status, 503);
    assert.equal(e.code, 'NO_API_KEY');
    return true;
  });
});

// service worker 冷启动 / 扩展重载时通道会断，约定用 status 0 表示"服务不可达"，
// 这样 outbox 逻辑与 userscript 路径完全一致，不必为扩展另写一套
await t('status 0（不可达）也按失败处理', async () => {
  api.setTransport(async () => ({ status: 0, body: { error: '本地服务不可达' } }));
  await assert.rejects(() => api.health(), /不可达/);
});

await t('响应体缺失时不抛 TypeError', async () => {
  api.setTransport(async () => ({ status: 200 }));
  assert.deepEqual(await api.health(), {});
});

await t('推送失败时入 outbox（与传输层实现无关）', async () => {
  store.clear();
  api.setTransport(async () => ({ status: 0, body: { error: 'down' } }));
  const ok = await api.pushEvents([{ id: 'e1', urlKey: 'a', action: 'highlight' }]);
  assert.equal(ok, false);
  assert.equal(api.outboxSize(), 1, 'outbox 没落盘');
});

await t('恢复后补发并清空 outbox', async () => {
  const sent = [];
  api.setTransport(async (path, init) => {
    if (path === '/events') sent.push(JSON.parse(init.body).events.length);
    return { status: 200, body: {} };
  });
  const n = await api.flushOutbox();
  assert.equal(n, 1);
  assert.equal(api.outboxSize(), 0);
  assert.deepEqual(sent, [1]);
});

await t('删除失败不抛（离线时删除只影响本地）', async () => {
  api.setTransport(async () => ({ status: 0, body: {} }));
  assert.equal(await api.deleteEvent('x'), false);
});

console.log(`\n${pass} 项通过`);
