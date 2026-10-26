import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setBrowserStorage } from '../src/core/browser-storage.js';
import { legacyUrlKey } from '../src/core/urlkey.js';
import { blockPage, blockedScope, unblockPage, unblockPageKey, blocklistEntries } from '../src/skill/blocklist.js';
const data=new Map();
setBrowserStorage({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)});
const reset=()=>data.clear();

test('numeric v1 page rules retain their legacy aliases until explicitly restored', () => {
  reset();const upper='https://rules.test/Foo?id=AbC';
  data.set('contextflow:blocklist',JSON.stringify({pages:{[legacyUrlKey(upper)]:123}}));
  assert.equal(blockedScope(upper),'page');
  assert.equal(blockedScope('https://rules.test/foo?id=abc'),'page','old rule already covered both variants');
  unblockPage(upper);assert.equal(blockedScope(upper),null);assert.equal(blocklistEntries().pages.length,0);
});

test('new page rules are exact for path/query case and hash routes, while ordinary fragments remain in one page', () => {
  reset();blockPage('https://rules.test/Foo?id=AbC');
  assert.equal(blockedScope('https://rules.test/Foo?id=AbC#section'),'page');
  assert.equal(blockedScope('https://rules.test/foo?id=abc'),null);
  reset();blockPage('https://rules.test/#/article/one');
  assert.equal(blockedScope('https://rules.test/#/article/one'),'page');
  assert.equal(blockedScope('https://rules.test/#/article/two'),null);
});

test('restoring a case variant never removes another v2 exact rule; direct rule-list removal still works', () => {
  reset();blockPage('https://rules.test/foo');
  unblockPage('https://rules.test/Foo');assert.equal(blockedScope('https://rules.test/foo'),'page');
  const row=blocklistEntries().pages[0];assert.equal(typeof row.at,'number');
  unblockPageKey(row.key);assert.equal(blocklistEntries().pages.length,0);
});

test('v1 hash-router suppression is preserved beside unrelated new precise rules', () => {
  reset();const first='https://rules.test/#/one';
  data.set('contextflow:blocklist',JSON.stringify({pages:{[legacyUrlKey(first)]:10}}));
  blockPage('https://rules.test/Other');
  assert.equal(blockedScope('https://rules.test/#/two'),'page');
  unblockPage(first);assert.equal(blockedScope('https://rules.test/#/two'),null);
  assert.equal(blockedScope('https://rules.test/Other'),'page');
});
