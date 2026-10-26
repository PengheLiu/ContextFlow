import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { articleSession } from '../src/skill/article-session.js';
import { urlKey } from '../src/core/urlkey.js';

const dom = new JSDOM('<!doctype html><title>Article A</title><p>source text</p>', { url: 'https://background.test/ArticleA' });
for (const name of ['window', 'document', 'location', 'localStorage']) globalThis[name] = dom.window[name];
const { App } = await import('../src/skill/main.js');
const api = await import('../src/core/api.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const range = { toString: () => 'source text', getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 10, width: 20, height: 10 }) };
function popover() {
  return { open$: true, open() { this.open$ = true; return this; }, body() { return this; }, foot() { return this; },
    answer() { return this; }, showRefresh() { return this; }, supplement() { return this; }, focus() { return this; },
    question: () => 'why', submitState() { return this; }, progress() { return this; },
    close() { this.open$ = false; }, dispose() { this.open$ = false; } };
}
function bare() {
  const app = new App(); app.unsubscribeTheme?.(); app.unsubscribeTheme = null;
  app.items = []; app.online = true;
  app.panel = { open: true, render() {}, renderStatus() {}, renderBrief() {}, syncMsg() {}, dispose() {} };
  app.hl = { clear() {} }; app.reanchor = () => {}; app.hideTbSoon = () => {};
  app.snapshot = () => ({ anchor: null, offset: 0 });
  app.persist = () => Promise.resolve(); app.uploadArticle = () => Promise.resolve();
  app.tipFor = kind => { app.pops ??= {}; return app.pops[kind] ??= popover(); };
  return app;
}
function route(path) { dom.window.history.pushState({}, '', path); document.title = path; }

test('returning during an explanation upload retains the active request instead of marking it interrupted', async () => {
  localStorage.clear(); route('/ArticleA');
  const app = bare(), upload = deferred(); let requests = 0;
  app.uploadArticle = () => upload.promise;
  api.setTransport(async path => {
    assert.equal(path, '/explain'); requests++;
    return { status: 200, body: { answer: 'answer for A' } };
  });
  app.doExplain(range);
  const run = app.runExplain('why');
  try {
    assert.equal(app.hasBackgroundWork(), true);
    route('/ArticleB'); app.retired = true;
    route('/ArticleA'); app.retired = false;
    await app.resumePending();
    assert.equal(app.items[0].extra.status, 'running');
  } finally { upload.resolve(); await run; }
  assert.equal(requests, 1);
  assert.equal(app.items[0].value, 'answer for A');
  assert.equal(app.items[0].urlKey, 'https://background.test/ArticleA');
});

test('a first translation is background work from upload until completion and repeated activation is deduplicated', async () => {
  localStorage.clear(); route('/TranslationA');
  const app = bare(), upload = deferred(), response = deferred(); let uploads = 0, requests = 0;
  app.uploadArticle = () => { uploads++; return upload.promise; };
  api.setTransport(async path => { assert.equal(path, '/translate'); requests++; return response.promise; });
  const run = app.doTranslate(range);
  try {
    assert.equal(app.hasBackgroundWork(), true, 'retain the owner while its article upload is pending');
    app.doTranslate(range);
    assert.equal(uploads, 1, 'the same active selection must not start a second translation');
    upload.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(requests, 1);
    assert.equal(app.hasBackgroundWork(), true, 'retain the owner while the provider is answering');
  } finally {
    upload.resolve(); response.resolve({ status: 200, body: { translation: 'translated A' } }); await run;
  }
  assert.equal(app.hasBackgroundWork(), false);
  assert.equal(app.items.filter(row => row.action === 'translate').length, 1);
});

test('the article cache retains a translating owner beyond its idle limit and returns to that exact App', async () => {
  localStorage.clear(); route('/CacheA');
  const response = deferred(), made = [];
  api.setTransport(async path => { assert.equal(path, '/translate'); return response.promise; });
  const session = articleSession({ keyOf: urlKey, href: () => location.href, limit: 2,
    host: { addEventListener() {}, removeEventListener() {} },
    create: () => {
      const app = bare(); made.push(app);
      app.start = async () => { app.retired = false; app.suspended = false; app.panel = { open: true }; };
      app.suspend = () => { app.suspended = true; };
      app.deactivate = () => { app.retired = true; };
      app.flushForNavigation = async () => {};
      return app;
    },
  });
  await session.start(); const a = session.currentArticle;
  a.panel = { render() {}, renderStatus() {} };
  const run = a.doTranslate(range);
  try {
    await Promise.resolve();
    for (const path of ['/CacheB', '/CacheC', '/CacheD']) { route(path); await session.checkArticle(); }
    route('/CacheA'); await session.checkArticle();
    assert.equal(session.currentArticle, a, 'an unfinished translation must not get a second owner with the same stable event IDs');
    assert.equal(made.filter(app => app.key === a.key).length, 1);
  } finally {
    a.panel = { render() {}, renderStatus() {} };
    response.resolve({ status: 200, body: { translation: 'retained A result' } }); await run;
    session.disposeSession();
  }
  assert.equal(a.items.find(row => row.action === 'translate').urlKey, 'https://background.test/CacheA');
});
