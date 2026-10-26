import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import * as store from '../src/core/offline-store.js';

const event=(id,parentId=null,extra={})=>({id,parentId,urlKey:'restore-relations',url:'https://restore-relations.test/article',
  title:'Restore relations',action:'comment',text:'source',value:'saved',createdAt:1,updatedAt:2,mutationId:`m-${id}`,...extra});
const rows=async()=>new Map((await store.readingLibrarySnapshot()).events.map(row=>[row.id,row]));

test('restore excludes all descendants of a local tombstone, independent of backup order',async()=>{
  await store.saveOfflineEvents([event('removed-root',null,{deletedAt:9}),event('old-child','removed-root')],{queue:false});
  const result=await store.restoreReadingLibrary({events:[event('grandchild','new-child'),event('new-child','removed-root'),
    event('under-existing-child','old-child'),event('separate')],assets:[]});
  assert.deepEqual(result,{added:1,skipped:3});
  const current=await rows();assert.equal(current.get('removed-root').deletedAt,9);assert.equal(current.get('old-child').parentId,'removed-root');
  for(const id of ['new-child','grandchild','under-existing-child'])assert.equal(current.has(id),false);
  assert.ok(current.has('separate'));
});

test('cyclic or self-parented new records reject the entire transaction before any additions',async()=>{
  for(const events of [[event('unrelated-before-cycle'),event('cycle-a','cycle-b'),event('cycle-b','cycle-c'),event('cycle-c','cycle-a')],
    [event('unrelated-before-self'),event('self-cycle','self-cycle')]]) {
    const before=await rows(),operations=await store.operationCount();
    await assert.rejects(()=>store.restoreReadingLibrary({events,assets:[]}),/循环/);
    assert.deepEqual([...await rows()],[...before]);assert.equal(await store.operationCount(),operations);
  }
});

test('current parentage wins over stale duplicate metadata; unordered valid chains and absent parents remain importable',async()=>{
  await store.saveOfflineEvents([event('current-parent')],{queue:false});
  const result=await store.restoreReadingLibrary({events:[event('current-parent','removed-root'),event('new-under-current','current-parent'),
    event('valid-child','valid-parent'),event('valid-parent'),event('orphan-preserved','not-in-this-backup')],assets:[]});
  assert.deepEqual(result,{added:4,skipped:1});
  const current=await rows();assert.equal(current.get('current-parent').parentId,null);assert.ok(current.has('new-under-current'));
  assert.equal(current.get('valid-child').parentId,'valid-parent');assert.ok(current.has('orphan-preserved'));
});

test('deep reversed parent chains are handled iteratively and late storage failures still roll everything back',async()=>{
  const deep=Array.from({length:2001},(_,i)=>event(`deep-${i}`,i ? `deep-${i-1}` : 'removed-root')).reverse();
  assert.deepEqual(await store.restoreReadingLibrary({events:deep,assets:[]}),{added:0,skipped:2001});
  const before=await rows(),operations=await store.operationCount();
  await assert.rejects(()=>store.restoreReadingLibrary({events:[event('must-rollback-parent'),event('must-rollback-child','must-rollback-parent')],
    assets:[{blob:new Blob(['bad-key'])}]}));
  assert.deepEqual([...await rows()],[...before]);assert.equal(await store.operationCount(),operations);
});
