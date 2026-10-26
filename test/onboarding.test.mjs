import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeRoot, resolveWithin } from '../server/paths.mjs';
import { setupStatus } from '../server/config.mjs';
import { testConnection, trimBase, listModels, modelDraft } from '../server/llm.mjs';
import { checkReleaseLinks } from '../tools/check-release-links.mjs';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

assert.equal(normalizeRoot('~/ContextFlow'), join(homedir(), 'ContextFlow'));
assert.equal(normalizeRoot('"~/My Notes"'), join(homedir(), 'My Notes'));
assert.equal(normalizeRoot(''), '');
assert.throws(() => normalizeRoot('relative/path'), /绝对路径/);
assert.throws(() => resolveWithin('/tmp/vault', '../vault-other'), /越出根目录/);
assert.equal(resolveWithin('/tmp/vault', '/Reading'), '/tmp/vault/Reading');
assert.equal(trimBase('https://example.test/v1/chat/completions/'), 'https://example.test');
assert.equal(trimBase('https://example.test/api/v1/messages'), 'https://example.test/api');
assert.deepEqual(setupStatus({}), { llmConfigured: false, explainConfigured: false });
assert.deepEqual(setupStatus({ translate: { apiKey: 'key', model: 'm', provider: 'openai' } }), { llmConfigured: false, explainConfigured: false });
assert.deepEqual(setupStatus({ explain: { backend: 'agent' }, agent: { id: 'claude' } }), { llmConfigured: false, explainConfigured: true });
const cfg = { translate: { apiKey: 'only-test', model: 'mock-model', provider: 'openai', baseUrl: 'http://example.test' } };
const beforeDraft = JSON.stringify(cfg);
const preview = modelDraft(cfg, { translate: { model: 'draft-model' }, agent: { profile: 'full' } });
assert.equal(preview.translate.model, 'draft-model');
assert.equal(preview.translate.apiKey, 'only-test');
assert.equal(JSON.stringify(cfg), beforeDraft, '连接草稿不得修改持久配置对象');
assert.equal(preview.agent, undefined, '模型连接草稿不得接受权限配置');
assert.throws(() => modelDraft(cfg, { translate: { baseUrl: 'https://other.test' } }), /重新填写 API key/);
assert.equal(modelDraft(cfg, { translate: { baseUrl: 'http://example.test/v1/' } }).translate.apiKey, 'only-test');
assert.equal(modelDraft(cfg, { translate: { baseUrl: 'https://other.test', apiKey: 'new-key' } }).translate.apiKey, 'new-key');
assert.throws(() => modelDraft(cfg, { translate: { model: {} } }), /必须是文字/);
assert.throws(() => modelDraft(cfg, { translate: null }), /格式不正确/);
assert.throws(() => modelDraft(cfg, null), /格式不正确/);
assert.throws(() => modelDraft(cfg, []), /格式不正确/);
assert.deepEqual(setupStatus(cfg), { llmConfigured: true, explainConfigured: true });
const published = await checkReleaseLinks('0.3.2', async (url, init) => {
  assert.equal(init.method, 'HEAD');
  assert.ok(url.startsWith('https://'));
  return { ok: true };
});
assert.equal(published.length, 3);
await assert.rejects(() => checkReleaseLinks('0.3.2', async () => ({ ok: false, status: 404 })), /先发布匹配版本/);
const original = globalThis.fetch;
try {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    assert.ok(init.signal);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
  };
  assert.deepEqual(await testConnection(cfg), { ok: true, model: 'mock-model' });
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.messages.map((message) => message.content), ['This is a connection check. Reply only OK.', 'OK']);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid key' } }) });
  await assert.rejects(() => testConnection(cfg), /401/);
  globalThis.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(() => testConnection(cfg), /超时/);
  await assert.rejects(() => testConnection({ translate: {} }), /未配置 API key/);
  await assert.rejects(() => testConnection({ translate: { ...cfg.translate, baseUrl: 'not-a-url' } }), /http:\/\//);
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://example.test/v1/models');
    assert.ok(init.signal);
    return { ok: true, json: async () => ({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: '' }, null] }) };
  };
  assert.deepEqual(await listModels(cfg), ['a', 'b']);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.deepEqual(await listModels(cfg), []);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: {} }) });
  await assert.rejects(() => listModels(cfg), /有效的模型列表/);
  globalThis.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(() => listModels(cfg), /获取模型列表超时/);
} finally { globalThis.fetch = original; }
console.log('新手配置：用户目录展开、拒绝相对路径与越界、AI 配置完整性、固定消息测试及错误反馈通过');

// Exercise the actual options entrypoint, not a second model of its states.
const optionsHTML = readFileSync(new URL('../extension/options.html', import.meta.url), 'utf8');
const navigationDOM = new JSDOM(optionsHTML);
const navigationLinks = [...navigationDOM.window.document.querySelectorAll('nav.page-nav a')];
assert.deepEqual(navigationLinks.map(link => [link.textContent, link.getAttribute('href'), link.dataset.view]), [
  ['开始使用', '#start', 'start'], ['连接与设置', '#connect', 'connect'],
  ['我的阅读库', '#library', 'library'], ['帮助与诊断', '#support', 'support'],
], '导航显示顺序、hash 和实际视图保持一致');
assert.ok(navigationLinks.every(link => link.tabIndex === 0 && !link.hasAttribute('tabindex')),
  '键盘使用自然 DOM 顺序，不用正 tabindex 制造不同的焦点顺序');
navigationDOM.window.close();
const optionsBundle = buildSync({ entryPoints: [new URL('../src/ext/options.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' }).outputFiles[0].text;
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('等待扩展引导界面状态超时');
};
const harness = async ({ paired = false, source = 'companion', state = 'unpaired', setup } = {}) => {
  const dom = new JSDOM(optionsHTML, { url: 'chrome-extension://' + 'a'.repeat(32) + '/options.html#connect',
    runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = () => ({ matches: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = [], stored = setup ? { desktopSetup: structuredClone(setup) } : {};
  const model = { translate: { provider: 'openai', baseUrl: '', model: '', target: '简体中文', apiKeySet: false },
    explain: { backend: 'llm' }, agent: { id: '', profile: 'safe', notesDir: '', executable: '' },
    sync: { backend: 'markdown' }, markdown: { dir: '/tmp/contextflow-test', folder: '/阅读记录' },
    obsidian: { vaultPath: '', folder: '/阅读记录' }, siyuan: { origin: 'http://127.0.0.1:6806', tokenSet: false } };
  const service = { ok: true, serviceVersion: '1.0.0', capabilities: ['llm.draft', 'llm.test', 'connection.checks'], jobs: { running: 0, queued: 0 } };
  const control = { state, paired, source, nativeError: '', config: model };
  window.chrome = {
    storage: { local: { get: async key => ({ [key]: structuredClone(stored[key]) }),
      set: async values => Object.assign(stored, structuredClone(values)) } },
    runtime: { id: 'a'.repeat(32), getManifest: () => ({ version: '1.0.0' }),
      sendMessage(message, callback) {
        calls.push(structuredClone(message));
        queueMicrotask(() => {
          let value;
          if (message.type === 'cf-fetch') {
            const body = message.path === '/config' ? structuredClone(control.config)
              : message.path.startsWith('/fs/folders') ? { root: '/tmp/contextflow-test', folders: ['/阅读记录'] } : service;
            callback({ status: 200, body }); return;
          }
          if (message.type === 'cf-status') value = { paired: control.paired, source: control.source };
          else if (message.type === 'cf-check') value = { state: control.state, service };
          else if (message.type === 'cf-connect-native') {
            if (control.nativeError) { callback({ ok: false, error: control.nativeError }); return; }
            control.paired = true; control.source = 'desktop'; control.state = 'connected'; value = { paired: true };
          } else if (message.type === 'cf-disconnect') { control.paired = false; control.state = 'unpaired'; value = true; }
          else value = true;
          callback({ ok: true, value });
        });
      } },
  };
  window.eval(optionsBundle);
  await until(() => window.document.getElementById('connection-state').textContent !== '正在读取连接状态…');
  const $ = id => window.document.getElementById(id);
  return { dom, window, $, calls, stored, control };
};

const fresh = await harness();
try {
  const { $, calls, window, stored, control } = fresh;
  assert.equal(window.document.body.dataset.view, 'connect');
  assert.equal($('advanced-connection').open, false, '终端方式应默认折叠');
  assert.ok($('advanced-connection').contains($('pair-form')));
  assert.ok($('advanced-connection').contains($('install-command')));
  assert.equal($('download-desktop').href, 'https://pengheliu.github.io/ContextFlow/download.html');
  assert.equal($('connect-desktop').disabled, true);
  assert.equal(calls.some(call => call.type === 'cf-connect-native'), false, '首次打开不能自动唤醒或授权');
  $('download-desktop').addEventListener('click', event => event.preventDefault());
  $('download-desktop').click();
  await until(() => !!stored.desktopSetup?.downloadViewedAt);
  assert.match($('download-progress').textContent, /不代表安装已经完成/);
  assert.equal(calls.some(call => call.type === 'cf-connect-native'), false, '前往官网下载不应调用 Native Messaging');
  $('desktop-consent').checked = true;
  $('desktop-consent').dispatchEvent(new window.Event('change'));
  await until(() => stored.desktopSetup?.consent === true);
  assert.deepEqual(Object.keys(stored.desktopSetup).sort(), ['consent', 'downloadViewedAt', 'version']);
  assert.equal($('connect-desktop').disabled, false);
  control.nativeError = '已取消连接，未授予浏览器访问权限。';
  $('connect-desktop').click();
  await until(() => $('desktop-status').dataset.error === 'true');
  assert.equal($('desktop-consent').checked, true, '取消后保留已确认说明，允许用户主动重试');
  assert.equal($('connect-desktop').disabled, false);
  assert.equal($('desktop-consent').disabled, false);
  assert.match($('desktop-status').textContent, /已取消/);
  control.nativeError = '';
  $('connect-desktop').click();
  await until(() => !$('next-step').hidden && !$('connect-desktop').hasAttribute('aria-busy'));
  assert.equal($('desktop-connect').hidden, true);
  assert.equal($('advanced-connection').open, false, '桌面连接成功不应展开终端安装');
  assert.equal(calls.filter(call => call.type === 'cf-connect-native').length, 2);
  assert.equal(calls.some(call => call.type === 'cf-fetch' && (/\/(llm|agents)\/(test|models)/.test(call.path) || call.init?.method === 'POST')), false,
    '引导、配对和读取配置不应自动测试模型或保存设置');
  const field = $('configuration').shadowRoot.getElementById('s-model');
  field.value = 'unsaved-draft'; field.dispatchEvent(new window.Event('input', { bubbles: true }));
  control.config.translate.model = 'changed-on-desktop';
  $('check-connection').click();
  await until(() => !$('check-connection').disabled);
  assert.equal(field.value, 'unsaved-draft', '重新检查连接不得覆盖未保存的设置草稿');
  $('disconnect').click();
  await until(() => !$('desktop-connect').hidden && $('connection-tools').hidden);
  assert.equal($('desktop-consent').checked, false, '主动断开后重新确认数据说明');
  assert.match($('desktop-status').textContent, /未删除/);
} finally { fresh.dom.window.close(); }

for (const source of ['desktop', 'companion']) {
  const resumed = await harness({ paired: true, source, state: 'unavailable',
    setup: { version: 1, consent: true, downloadViewedAt: 1 } });
  try {
    assert.equal(resumed.$('desktop-consent').checked, true, '返回扩展应续接非敏感说明勾选');
    assert.equal(resumed.$('advanced-connection').open, source === 'companion');
    assert.match(resumed.$('connection-next').textContent, source === 'desktop' ? /打开 ContextFlow 桌面端/ : /命令行服务/);
    assert.equal(resumed.calls.some(call => call.type === 'cf-connect-native'), false, '重开与离线检查不能自动唤醒桌面端');
    resumed.control.state = 'unauthorized';
    resumed.$('check-connection').click();
    await until(() => !resumed.$('check-connection').disabled);
    assert.match(resumed.$('connection-state').textContent, source === 'desktop' ? /浏览器授权已失效/ : /配对码已失效/);
    assert.equal(resumed.$('advanced-connection').open, source === 'companion');
  } finally { resumed.dom.window.close(); }
}
console.log('扩展产品流程：阅读即用、官网下载主入口、兼容路径折叠、说明续接、显式授权/取消重试、离线分流与草稿保护通过');
