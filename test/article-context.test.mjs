import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><title>Article A</title><p>Article A</p>', { url: 'https://example.test/ArticleA' });
for (const name of ['window', 'document', 'location', 'localStorage']) globalThis[name] = dom.window[name];
const { App } = await import('../src/skill/main.js');
const { lookupId, hashKey, lookupKey } = await import('../src/core/lookupkey.js');
test('late results and notes retain their captured article metadata after navigation', () => {
  const app = new App(); app.panel = { render() {}, renderStatus() {} }; app.reanchor = () => {};
  const saved = []; app.persist = events => { saved.push(...events); return Promise.resolve(); };
  dom.window.history.pushState({}, '', '/ArticleB'); document.title = 'Article B';
  app.saveLookup('explain', { text: 'A source', value: 'A answer', anchor: null });
  app.saveNote('A note');
  for (const event of saved) { assert.equal(event.urlKey, 'https://example.test/ArticleA'); assert.equal(event.url, 'https://example.test/ArticleA'); assert.equal(event.title, 'Article A'); }
  assert.match(saved[1].id, /^note:2:/);
  app.unsubscribeTheme?.();
});
test('a stale toolbar action cannot write current-page text under an old article', () => {
  const app = new App(); let persisted = false, checked = 0;
  app.onRouteChange = () => { checked++; }; app.persist = () => { persisted = true; };
  dom.window.history.pushState({}, '', '/ArticleC');
  app.addHighlight({ getBoundingClientRect() { throw new Error('must not inspect the new selection'); } }, 'yellow', true);
  assert.equal(persisted, false); assert.equal(checked, 1); app.unsubscribeTheme?.();
});
test('new stable lookup ids cannot collide with retained IDs from a migrated legacy bucket', () => {
  const event = { action: 'explain', text: 'same', extra: { question: 'same' } }, key = 'https://example.test/a';
  const old = `ex:${hashKey(key + '\u001f' + lookupKey(event))}`;
  assert.notEqual(lookupId(key, event), old); assert.equal(lookupId(key, event), lookupId(key, event));
});
test('an unsettled image keeps its original inline editor and sidebar editing identity', () => {
  const app = new App(), marked = [];
  app.editingCommentId = 'previous';
  app.panel = { markCommentEditing: (...args) => marked.push(args) };
  app.commentTipFor = () => ({ id: 'previous', open$: true, open() {} });
  app.commentValue = () => '';
  assert.equal(app.openCommentEditor({ id: 'next', text: 'next passage' }, {}), false);
  assert.equal(app.editingCommentId, 'previous'); assert.deepEqual(marked, []);
  app.unsubscribeTheme?.();
});
