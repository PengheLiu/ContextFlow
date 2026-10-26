import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory=mkdtempSync(join(tmpdir(),'contextflow-db-close-'));
process.env.CONTEXTFLOW_DIR=directory;
const db=await import('../server/db.mjs');

test('normal database close checkpoints committed WAL and permits a complete main-file snapshot and reopen', () => {
  const original=db.open();original.exec('PRAGMA wal_autocheckpoint=0');
  db.upsertEvents([{id:'checkpoint-fixture',urlKey:'close-fixture',url:'https://close.test/article',title:'Fixture',action:'comment',text:'source',value:'durable note',createdAt:1,updatedAt:2,mutationId:'close-test'}]);
  const wal=join(directory,'context.db-wal');assert.ok(existsSync(wal)&&statSync(wal).size>0,'test must actually contain committed WAL');
  assert.equal(db.close().checkpointed,true);
  assert.ok(!existsSync(wal)||statSync(wal).size===0,'normal shutdown should not leave committed data only in WAL');
  const copy=join(directory,'snapshot-main-only.db');copyFileSync(join(directory,'context.db'),copy);
  const snapshot=new DatabaseSync(copy);
  try {assert.equal(snapshot.prepare('SELECT value FROM events WHERE id = ?').get('checkpoint-fixture').value,'durable note');}
  finally {snapshot.close();}
  assert.doesNotThrow(()=>db.close(),'close is idempotent');
  assert.notEqual(db.open(),original);assert.equal(db.stats().total,1);db.close();
});
