// 本地镜像 ↔ 服务端对账。
// 这段逻辑能删掉用户数据，所以边界条件必须一条条钉住。
import assert from 'node:assert/strict';
import { reconcile } from '../src/core/reconcile.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const ev = (id, extra = {}) => ({ id, action: 'translate', ...extra });
const ids = (arr) => arr.map((e) => e.id).sort().join(',');
const setOf = (...xs) => new Set(xs);

console.log('本地镜像与服务端对账\n');

t('服务端为事实源：本地多出来的被淘汰', () => {
  const local = [ev('a'), ev('dup1'), ev('dup2')];
  const out = reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a', 'dup1', 'dup2') });
  assert.equal(ids(out), 'a');
});

t('服务端的修改覆盖本地同 id', () => {
  const out = reconcile([ev('a', { value: '旧' })], [ev('a', { value: '新' })],
    { pending: 0, localBefore: setOf('a') });
  assert.equal(out.length, 1);
  assert.equal(out[0].value, '新');
});

t('服务端新增的会进来', () => {
  const out = reconcile([ev('a')], [ev('a'), ev('b')], { pending: 0, localBefore: setOf('a') });
  assert.equal(ids(out), 'a,b');
});

// ---- 三道安全阀 ----

t('有积压时不淘汰 —— 那些本地记录可能只是还没推上去', () => {
  const local = [ev('a'), ev('未推送')];
  const out = reconcile(local, [ev('a')], { pending: 1, localBefore: setOf('a', '未推送') });
  assert.equal(ids(out), 'a,未推送');
});

t('服务端全空时不淘汰 —— 更可能是库被重置，不是用户删空了', () => {
  const local = [ev('a'), ev('b')];
  const out = reconcile(local, [], { pending: 0, localBefore: setOf('a', 'b') });
  assert.equal(ids(out), 'a,b');
});

t('请求期间新增的不被淘汰（不在 localBefore 里）', () => {
  const local = [ev('a'), ev('刚划的')];
  // localBefore 是发请求前的快照，不含"刚划的"
  const out = reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a') });
  assert.equal(ids(out), 'a,刚划的');
});

// 提交解释后会先落一条只存本地的"进行中"记录（服务端还没有它）。
// 按"服务端没有就是被删了"处理，正在跑的解释会在下一次同步时凭空消失。
t('未完成的查询记录不被淘汰（它本来就只在本地）', () => {
  const local = [ev('a'),
    { id: '进行中', action: 'explain', value: null, extra: { status: 'running' } }];
  const out = reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a', '进行中') });
  assert.equal(ids(out), 'a,进行中');
});

t('拿到结果后就按普通记录处理（服务端没有即视为已删）', () => {
  const local = [ev('a'),
    { id: '已完成', action: 'explain', value: '答案', extra: { status: 'running' } }];
  const out = reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a', '已完成') });
  assert.equal(ids(out), 'a');
});

// 判据必须是显式标记。第一版写成"没有 value 就算进行中"，于是把本该淘汰的
// 重复记录也留下了 —— 下面这条就是那次的回归。
t('没有 extra.status 的无值记录仍按普通记录淘汰', () => {
  const local = [ev('a'), { id: '普通无值', action: 'translate', value: null }];
  const out = reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a', '普通无值') });
  assert.equal(ids(out), 'a');
});

t('未完成但已软删除的仍然淘汰', () => {
  const local = [ev('a'),
    { id: 'x', action: 'explain', value: null, deletedAt: 1, extra: { status: 'running' } }];
  const out = reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a', 'x') });
  assert.equal(ids(out), 'a');
});

// ---- 软删除 ----

t('服务端标记 deletedAt 的不进结果', () => {
  const out = reconcile([ev('a')], [ev('a', { deletedAt: 123 })],
    { pending: 0, localBefore: setOf('a') });
  assert.deepEqual(out, []);
});

t('本地标记 deletedAt 的也不进结果', () => {
  const out = reconcile([ev('x', { deletedAt: 1 })], [ev('a')],
    { pending: 1, localBefore: setOf('x') });
  assert.equal(ids(out), 'a');
});

// ---- 退化情形 ----

t('本地为空：直接取服务端', () => {
  const out = reconcile([], [ev('a'), ev('b')], { pending: 0, localBefore: setOf() });
  assert.equal(ids(out), 'a,b');
});

t('两边都空', () => {
  assert.deepEqual(reconcile([], [], { pending: 0, localBefore: setOf() }), []);
});

t('不改动入参数组', () => {
  const local = [ev('a'), ev('b')];
  reconcile(local, [ev('a')], { pending: 0, localBefore: setOf('a', 'b') });
  assert.equal(ids(local), 'a,b');
});

t('结果里不出现重复 id', () => {
  const local = [ev('a'), ev('b')];
  const out = reconcile(local, [ev('a'), ev('b')], { pending: 0, localBefore: setOf('a', 'b') });
  assert.equal(out.length, new Set(out.map((e) => e.id)).size);
});

console.log(`\n${pass} 项通过`);
