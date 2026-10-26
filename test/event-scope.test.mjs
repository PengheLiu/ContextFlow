import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventScope } from '../src/skill/event-scope.js';

test('EventScope removes exact listeners with their capture semantics and is idempotent', () => {
  const calls = [], target = { addEventListener: (...args) => calls.push(['add', ...args]), removeEventListener: (...args) => calls.push(['remove', ...args]) };
  const scope = new EventScope(), listener = () => {};
  const off = scope.listen(target, 'click', listener, { capture: true, passive: true });
  scope.listen(target, 'keydown', listener, false); off(); off(); scope.dispose(); scope.dispose();
  assert.deepEqual(calls.filter(row => row[0] === 'remove'), [['remove', 'click', listener, true], ['remove', 'keydown', listener, false]]);
  const before = calls.length; scope.listen(target, 'resize', listener); assert.equal(calls.length, before); assert.equal(scope.cleanups.size, 0);
});
test('Retired scope listeners never react to later page events', () => {
  const target = new EventTarget(), scope = new EventScope(); let count = 0;
  scope.listen(target, 'page-change', () => count++); target.dispatchEvent(new Event('page-change')); scope.dispose(); target.dispatchEvent(new Event('page-change'));
  assert.equal(count, 1);
});
