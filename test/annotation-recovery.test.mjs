import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { assetToken } from '../src/core/assets.js';

const dom = new JSDOM('<!doctype html><body><textarea id="host">host-owned draft</textarea></body>', { url: 'https://article.test/read' });
for (const name of ['window', 'document', 'location', 'localStorage', 'Node', 'NodeFilter', 'Range', 'MutationObserver']) globalThis[name] = dom.window[name];
globalThis.innerWidth = 1200; globalThis.innerHeight = 900;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const { App } = await import('../src/skill/main.js');
const bare = () => Object.assign(Object.create(App.prototype), {
  key: 'fixture-article', articleTitle: '协作 / 阅读', articleUrl: 'https://article.test/read',
  items: [{ id: 'highlight', text: 'Super-agent\n引用原文' }], commentDrafts: new Map(),
  failedLocalEvents: new Map(), localSaves: new Set(),
  persist() { throw new Error('emergency backup must not attempt persistence'); },
  flushForNavigation() { throw new Error('emergency backup must not attempt a disconnected flush'); },
});

test('emergency text backup retains the exact draft and provenance and labels omitted images honestly', () => {
  const app = bare(), text = '有个疑问：\n团队共享一个，还是每个人一个？';
  const source = `${text}\n\n${assetToken('a'.repeat(64), '截图')}`;
  const result = app.commentDraftBackup('highlight', source);
  assert.ok(result.text.startsWith(text)); assert.equal(result.images, 1);
  assert.match(result.text, /图片未包含：截图/);
  assert.doesNotMatch(result.markdown, /contextflow-asset:/);
  for (const value of ['未保存的批注草稿', '尚未确认写入 ContextFlow 阅读库', app.articleUrl, '> Super-agent\n> 引用原文', text, '1 张图片未包含']) assert.ok(result.markdown.includes(value), value);
  assert.equal(app.commentDraftBackup('highlight', text).text, text);
});

test('the real inline editor receives backup actions from its owning App', async () => {
  const app = bare(), calls = [];
  app.copyCommentDraft = async (id, value) => { calls.push(['copy', id, value]); return 'copied fixture draft'; };
  app.downloadCommentDraft = (id, value) => { calls.push(['download', id, value]); return 'downloaded fixture draft'; };
  const editor = app.commentTipFor();
  try {
    editor.open({ left: 10, top: 20, bottom: 30, width: 100 }, { id: 'highlight', value: 'the current editable draft' });
    editor.preserveDisconnectedDraft(Object.assign(new Error('save channel lost'), { code: 'EXTENSION_CONTEXT_INVALIDATED' }));
    await editor.backupDraft('copy'); await editor.backupDraft('download');
    assert.deepEqual(calls, [['copy', 'highlight', 'the current editable draft'], ['download', 'highlight', 'the current editable draft']]);
    assert.equal(editor.open$, true); assert.equal(editor.dirty, true);
  } finally { editor.dispose(); }
});

test('copy and download use the editable value without touching the extension, storage or save state', async () => {
  const app = bare(), draft = '必须保留的多行文字\n第二行';
  app.commentDrafts.set('highlight', draft);
  const previous = { chrome: globalThis.chrome, create: URL.createObjectURL, revoke: URL.revokeObjectURL,
    click: dom.window.HTMLAnchorElement.prototype.click, timeout: globalThis.setTimeout };
  const writes = [], downloads = [], blobs = [], revocations = [];
  localStorage.setItem('host-owned', 'preserve');
  const stored = JSON.stringify(Object.entries(localStorage));
  globalThis.chrome = new Proxy({}, { get() { throw new Error('backup cannot access chrome.runtime'); } });
  app.copyText = async text => writes.push(text);
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:isolated-draft'; };
  URL.revokeObjectURL = href => revocations.push(href);
  dom.window.HTMLAnchorElement.prototype.click = function() { downloads.push({ href: this.href, name: this.download }); };
  globalThis.setTimeout = fn => { fn(); return 0; };
  try {
    assert.match(await app.copyCommentDraft('highlight', draft), /文字已复制.*不代表阅读库保存成功/);
    assert.deepEqual(writes, [draft]);
    assert.match(app.downloadCommentDraft('highlight', draft), /确认文件已保存.*不代表阅读库保存成功/);
    assert.equal(downloads.length, 1); assert.match(downloads[0].name, /^未保存批注-.*\.md$/); assert.ok(!downloads[0].name.includes('/'));
    assert.match(await blobs[0].text(), /必须保留的多行文字\n第二行/);
    assert.deepEqual(revocations, ['blob:isolated-draft']);
    assert.equal(document.querySelector('a'), null);
    assert.equal(app.commentDrafts.get('highlight'), draft);
    assert.equal(JSON.stringify(Object.entries(localStorage)), stored);
    assert.equal(document.querySelector('#host').value, 'host-owned draft');
  } finally {
    globalThis.chrome = previous.chrome; URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke;
    dom.window.HTMLAnchorElement.prototype.click = previous.click; globalThis.setTimeout = previous.timeout;
  }
});

test('the registered unload guard protects failed text, unsettled images and pending local writes without blocking a clean page', () => {
  const app = bare();
  app.scheduleReanchor = () => {};
  app.wire();
  const leaving = () => { const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  try {
    assert.equal(leaving(), false);
    app.commentDrafts.set('highlight', 'unconfirmed'); assert.equal(leaving(), true);
    assert.equal(app.commentDrafts.get('highlight'), 'unconfirmed'); app.commentDrafts.clear();
    app.commentPop = { recoveryError: new Error('disconnected') }; assert.equal(leaving(), true);
    app.commentPop = { hasUnsettledAssets: true }; assert.equal(leaving(), true);
    app.commentPop = null;
    app.localSaves.add(Promise.resolve()); assert.equal(leaving(), true); app.localSaves.clear();
    app.failedLocalEvents.set('highlight', {}); assert.equal(leaving(), true); app.failedLocalEvents.clear();
    app.panel = { composers: new Map([['highlight', { dirty: true }]]) }; assert.equal(leaving(), true);
    app.panel.composers.clear(); assert.equal(leaving(), false);
  } finally {
    for (const [target, type, listener, options] of app.pageListeners) target.removeEventListener(type, listener, options);
    app.observer.disconnect();
  }
});
