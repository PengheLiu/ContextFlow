import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.CONTEXTFLOW_DIR = mkdtempSync(join(tmpdir(), 'contextflow-url-db-'));
const db = await import('../server/db.mjs');
const sql = db.open();
function legacy(id, url, key, extra = {}) {
  sql.prepare('INSERT INTO events(id,urlKey,url,title,action,text,value,parentId,createdAt,updatedAt,mutationId,deletedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, key, url, id, extra.parentId ? 'comment' : 'highlight', 'quote', extra.value || null, extra.parentId || null, 1, 10, 'original-clock', extra.deletedAt || null);
}

test('SQLite URL repair preserves event identity and archives ambiguous external-document mappings', () => {
  const key='https://db-identity.test/foo';
  legacy('upper','https://db-identity.test/Foo',key);
  legacy('lower','https://db-identity.test/foo',key);
  legacy('child','https://db-identity.test/Foo',key,{parentId:'upper',value:'comment'});
  legacy('dead','https://db-identity.test/Foo',key,{deletedAt:11});
  db.putArtDoc(key,'markdown','old-mixed.md'); db.markSynced('upper','markdown','old-mixed.md#upper','hash');
  const result=db.migrateArticleIdentities();
  assert.equal(result.moved,3); assert.equal(result.split,1);
  assert.deepEqual(db.listByUrlKey('https://db-identity.test/Foo').map(row=>row.id).sort(),['child','dead','upper']);
  const moved=db.listByUrlKey('https://db-identity.test/Foo').find(row=>row.id==='child');
  assert.equal(moved.parentId,'upper'); assert.equal(moved.updatedAt,10); assert.equal(moved.mutationId,'original-clock');
  assert.equal(db.listByUrlKey(key).length,1);
  assert.equal(db.getArtDoc(key,'markdown'),null); assert.equal(db.getArtDoc('https://db-identity.test/Foo','markdown'),null);
  const archive=sql.prepare('SELECT kind,payload FROM url_identity_archive').all();
  assert.ok(archive.some(row=>row.kind==='artdoc'&&row.payload.includes('old-mixed.md')));
  assert.ok(archive.some(row=>row.kind==='synced'&&row.payload.includes('old-mixed.md#upper')));
  assert.match(db.docRefsOfBackend('markdown').get('old-mixed.md'), /^legacy-reserved:/);
  assert.equal(db.isArchivedArticleDoc('old-mixed.md', 'markdown'), true);
  assert.equal(db.eventsForArticle('https://db-identity.test/Foo','markdown').find(row=>row.id==='upper').syncedRef,null);
});

test('a proven single-article alias preserves its existing note mapping without overwriting a target mapping', () => {
  const old='https://db-single.test/case',current='https://db-single.test/Case';
  legacy('single',current,old); db.putArtDoc(old,'markdown','single.md');
  assert.equal(db.migrateArticleIdentities().moved,1);
  assert.equal(db.getArtDoc(current,'markdown'),'single.md');
  const conflictOld='https://db-conflict.test/case',target='https://db-conflict.test/Case';
  legacy('conflict',target,conflictOld); db.putArtDoc(conflictOld,'markdown','legacy.md'); db.putArtDoc(target,'markdown','current.md');
  db.markSynced('conflict','markdown','legacy.md#conflict','hash');
  db.migrateArticleIdentities();
  assert.equal(db.getArtDoc(target,'markdown'),'current.md');
  assert.equal(db.eventsForArticle(target,'markdown')[0].syncedRef,null);
});

test('older clients cannot put repaired rows back in colliding keys or steal another article ID', () => {
  db.upsertEvents([{id:'from-old-client',urlKey:'https://db-new.test/case',url:'https://db-new.test/Case',action:'highlight',text:'x',createdAt:1,updatedAt:20,mutationId:'a'}]);
  assert.equal(db.listByUrlKey('https://db-new.test/Case')[0].id,'from-old-client');
  assert.throws(()=>db.upsertEvents([{id:'from-old-client',urlKey:'https://other.test/article',url:'https://other.test/article',action:'highlight',text:'x',createdAt:1,updatedAt:30,mutationId:'b'}]),/身份|标识|冲突/);
  assert.equal(db.listByUrlKey('https://db-new.test/Case')[0].id,'from-old-client');
});

test('a failed SQL identity move rolls back all event and mapping/archive changes', () => {
  const old='https://rollback-db.test/case',target='https://rollback-db.test/Case';
  legacy('rollback-one',target,old);legacy('rollback-two',target,old);db.putArtDoc(old,'markdown','unchanged.md');
  sql.exec("CREATE TRIGGER fail_identity_move BEFORE UPDATE OF urlKey ON events WHEN OLD.id = 'rollback-two' BEGIN SELECT RAISE(ABORT,'fixture repair failure'); END");
  try {
    assert.throws(()=>db.migrateArticleIdentities(),/fixture repair failure/);
    assert.equal(db.getArtDoc(old,'markdown'),'unchanged.md');assert.equal(db.getArtDoc(target,'markdown'),null);
    assert.equal(db.listByUrlKey(old).length,2);
    assert.equal(sql.prepare('SELECT COUNT(*) count FROM url_identity_archive WHERE legacyKey = ?').get(old).count,0);
  } finally {sql.exec('DROP TRIGGER fail_identity_move');db.migrateArticleIdentities();}
});
