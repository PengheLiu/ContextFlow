import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as identity from '../src/core/urlkey.js';
import { libraryArticles } from '../src/core/reading-library.js';

test('article identities retain case-sensitive paths and query values', () => {
  assert.notEqual(identity.urlKey('https://Example.test/Foo.md'), identity.urlKey('https://example.test/foo.md'));
  assert.notEqual(identity.urlKey('https://example.test/article?id=AbC'), identity.urlKey('https://example.test/article?id=abc'));
  assert.equal(identity.urlKey('https://EXAMPLE.test/Foo.md?utm_source=x&ID=AbC#section'), 'https://example.test/Foo.md?ID=AbC');
});

test('ordinary document fragments share identity, hash application routes do not', () => {
  assert.equal(identity.urlKey('https://example.test/article#section-one'), identity.urlKey('https://example.test/article#section-two'));
  assert.notEqual(identity.urlKey('https://example.test/#/article/one'), identity.urlKey('https://example.test/#/article/two'));
  assert.notEqual(identity.urlKey('https://example.test/#!/Article?id=AbC'), identity.urlKey('https://example.test/#!/article?id=abc'));
  assert.equal(identity.urlKey('https://arxiv.org/html/2601.12345v2#section'), 'arxiv:2601.12345');
});

test('legacy aliases remain available without deciding that their colliding articles are equal', () => {
  const upper = identity.articleIdentity('https://example.test/Foo.md');
  const lower = identity.articleIdentity('https://example.test/foo.md');
  assert.equal(upper.legacyKey, lower.legacyKey);
  assert.notEqual(upper.key, lower.key);
  assert.equal(identity.legacyUrlKey('https://example.test/#/article/one'), identity.legacyUrlKey('https://example.test/#/article/two'));
});

test('only original URL evidence can split legacy records; custom and missing identities are not guessed', () => {
  const upper = { id: 'upper', urlKey: 'https://example.test/foo.md', url: 'https://example.test/Foo.md' };
  const lower = { id: 'lower', urlKey: 'https://example.test/foo.md', url: 'https://example.test/foo.md' };
  assert.equal(identity.eventIdentityKey(upper), 'https://example.test/Foo.md');
  assert.equal(identity.eventIdentityKey(lower), 'https://example.test/foo.md');
  assert.equal(identity.eventIdentityKey({ ...upper, url: '' }), upper.urlKey);
  assert.equal(identity.eventIdentityKey({ ...upper, urlKey: 'legacy-custom-key' }), 'legacy-custom-key');
  assert.equal(identity.eventIdentityKey({ ...upper, url: 'javascript:alert(1)' }), upper.urlKey);
});

test('library compatibility separates proven case variants without modifying the backup/source records', () => {
  const rows = [
    { id:'a',urlKey:'https://library.test/foo',url:'https://library.test/Foo',title:'Upper',action:'highlight' },
    { id:'b',urlKey:'https://library.test/foo',url:'https://library.test/foo',title:'Lower',action:'highlight' },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(libraryArticles(rows).map(row=>row.key).sort(), ['https://library.test/Foo','https://library.test/foo']);
  assert.deepEqual(rows,before);
});

test('a missing child URL can follow its proven parent, but conflicting parent evidence is not moved', () => {
  const parent={id:'parent',urlKey:'https://parent.test/foo',url:'https://parent.test/Foo',action:'highlight'};
  const child={id:'child',urlKey:parent.urlKey,url:'',parentId:parent.id,action:'comment'};
  const plan=identity.planArticleIdentityMigration([parent,child],identity.articleIdentity(parent.url));
  assert.equal(plan.moves.length,2);assert.equal(plan.moves.find(move=>move.event===child).to,identity.urlKey(parent.url));
  const conflict={...child,url:'https://other.test/article'};
  const blocked=identity.planArticleIdentityMigration([parent,conflict]);
  assert.equal(blocked.moves.length,0);assert.equal(blocked.ambiguous.length,2);
});
