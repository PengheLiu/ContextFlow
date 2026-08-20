// 列表排序比较器。批注与查询记录共用它，所以顺序错了会同时错两个 tab。
import assert from 'node:assert/strict';
import { byPosition } from '../src/core/order.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// pos 为 undefined 表示没有锚点
const mk = (id, createdAt) => ({ id, createdAt });
const posOf = (map) => (id) => map[id];
const ids = (arr) => arr.map((e) => e.id).join(',');

console.log('列表排序（按文档位置）\n');

t('按位置升序，与创建时间无关', () => {
  const items = [mk('a', 300), mk('b', 100), mk('c', 200)];
  const out = byPosition(items, posOf({ a: 90, b: 30, c: 60 }));
  assert.equal(ids(out), 'b,c,a');
});

t('位置 0 不能被当成"无位置"丢到末尾', () => {
  const items = [mk('a', 1), mk('b', 2)];
  const out = byPosition(items, posOf({ a: 50, b: 0 }));
  assert.equal(ids(out), 'b,a');   // 用 || 代替 ?? 就会错成 a,b
});

t('无位置（无锚点）的排到末尾', () => {
  const items = [mk('a', 1), mk('b', 2), mk('c', 3)];
  const out = byPosition(items, posOf({ a: 500, c: 10 }));
  assert.equal(ids(out), 'c,a,b');
});

t('位置相同按创建先后，保证稳定', () => {
  const items = [mk('a', 300), mk('b', 100), mk('c', 200)];
  const out = byPosition(items, posOf({ a: 5, b: 5, c: 5 }));
  assert.equal(ids(out), 'b,c,a');
});

t('多条都无位置时仍按创建先后，不是随机序', () => {
  const items = [mk('a', 300), mk('b', 100)];
  const out = byPosition(items, posOf({}));
  assert.equal(ids(out), 'b,a');
});

t('不改动入参数组', () => {
  const items = [mk('a', 1), mk('b', 2)];
  const before = ids(items);
  byPosition(items, posOf({ a: 99, b: 1 }));
  assert.equal(ids(items), before);
});

t('缺 createdAt 不抛，也不污染排序', () => {
  const items = [{ id: 'a' }, mk('b', 5)];
  const out = byPosition(items, posOf({ a: 7, b: 7 }));
  assert.equal(ids(out), 'a,b');
});

t('空数组', () => assert.deepEqual(byPosition([], posOf({})), []));

console.log(`\n${pass} 项通过`);
