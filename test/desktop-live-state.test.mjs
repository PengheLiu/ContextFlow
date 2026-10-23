import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startDesktopUI } from '../desktop/ui/renderer.js';
import { productState } from '../desktop/ui/product-state.js';
import { destinationIdentity } from '../src/core/destination.js';

// First-use regressions run against the real renderer and shared Settings form,
// with an isolated in-memory desktop/service. No CLI, provider or notes access.
const html = readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const configFixture = () => ({
  translate: { provider: 'openai', model: 'fixture-model', baseUrl: 'https://provider.invalid/v1', apiKeySet: true, target: '简体中文', chunkChars: 5000 },
  explain: { backend: 'llm' }, agent: { id: '', executable: '', notesDir: '', profile: 'safe', profileSource: 'new-default' },
  sync: { backend: 'markdown' }, markdown: { dir: '/isolated/notes', folder: '/阅读记录' },
  obsidian: { vaultPath: '', folder: '/阅读记录' }, siyuan: { origin: 'http://127.0.0.1:6806', notebookId: '', tokenSet: false },
  connectionChecks: {},
});
const agentFixture = () => ({ id: 'codex', label: 'Codex CLI', available: true, path: '/isolated/bin/codex', version: 'fixture-version', safeSupport: 'verified', connectionTestSupported: true });

async function fixture({ config = configFixture(), dismissed = false, step = 'tools', snapshotConfiguration = true, initialNativePage } = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://isolated-desktop.invalid/' });
  const previous = new Map();
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  const agent = agentFixture(), listeners = new Set(), calls = { status: 0, getConfig: 0, putConfig: 0, testAgent: 0, testModel: 0, unsubscribe: 0 };
  const state = {
    version: '1.0.0', platform: 'darwin', architecture: 'arm64', service: { state: 'running', message: '隔离测试服务已就绪' },
    pairings: [{ id: 'isolated-browser', label: 'Isolated browser' }], preferences: { openAtLogin: false }, bridgeReady: true, packaged: true,
    updates: { state: 'idle' }, recoveryPoints: [],
    journey: { step, dismissed, notesConfirmed: false, notesVerified: false, destination: destinationIdentity(config) },
    readingStatus: { ai: { verified: false, lastAnswerAt: null }, sync: { completed: false, changed: false, at: null } },
    discovery: { agents: { state: 'done', items: [agent] }, notes: { state: 'done', items: [] } },
  };
  let testedModel;
  const snapshot = () => {
    const value = clone(state);
    value.journey.destination = destinationIdentity(config);
    if (snapshotConfiguration) value.configuration = clone(config);
    return value;
  };
  const api = {
    getConfig: async () => { calls.getConfig++; return clone(config); },
    putConfig: async patch => {
      calls.putConfig++;
      for (const [key, value] of Object.entries(patch)) config[key] = { ...config[key], ...value };
      if (testedModel === config.translate.model) config.connectionChecks.model = { ok: true, checkedAt: 123456 };
      return clone(config);
    },
    listFolders: async () => ({ root: '/isolated', folders: ['/阅读记录'] }), listVaults: async () => ({ vaults: [] }),
    health: async () => ({ serviceVersion: '1.0.0', capabilities: ['llm.draft', 'agent.test', 'agent.test.draft', 'connection.checks', 'reading.status'] }),
    detectAgents: async () => ({ agents: [agent], connectionChecks: clone(config.connectionChecks) }),
    testAgent: async id => {
      calls.testAgent++;
      config.connectionChecks.agents = { [id]: { ok: true, checkedAt: 123456, path: agent.path, version: agent.version } };
      // Deliberately no push event: shared Settings must notify its desktop
      // owner when this explicit test settles, rather than waiting for polling.
      return { ok: true, agent: id, checkedAt: 123456, scope: 'connection-only' };
    },
    testModel: async draft => {
      calls.testModel++; testedModel = draft.model;
      if (draft.model === config.translate.model) config.connectionChecks.model = { ok: true, checkedAt: 123456 };
      return { ok: true, model: draft.model, checkedAt: 123456 };
    },
  };
  const desktop = {
    status: async () => { calls.status++; return snapshot(); }, request: async () => { throw new Error('Unexpected network request in isolated test'); },
    onStatusChange: callback => { listeners.add(callback); return () => { calls.unsubscribe++; listeners.delete(callback); }; },
    onNavigate: callback => { if (initialNativePage) queueMicrotask(() => callback(initialNativePage)); return () => {}; },
    onboarding: async patch => {
      if (patch.notesConfirmed && patch.expectedDestination !== destinationIdentity(config)) throw new Error('笔记位置已更改');
      const { expectedDestination, ...value } = patch; Object.assign(state.journey, value); return clone(state.journey);
    },
    chooseFolder: async () => null, chooseAgent: async () => null, action: async () => true,
    discover: async () => clone(state.discovery), preferences: async patch => Object.assign(state.preferences, patch),
    revoke: async () => {}, updates: async () => {}, recovery: async () => true,
  };
  const ui = startDesktopUI({ desktop, serviceAPI: api, root: dom.window.document, poll: false });
  await ui.ready; await tick();
  return { dom, ui, api, desktop, config, state, calls, listeners, $: id => dom.window.document.getElementById(id),
    async push() { for (const callback of [...listeners]) callback(); await tick(); },
    close() {
      ui.dispose(); dom.window.close();
      for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    },
  };
}

test('a native settings request before the first status frame is not replaced by initial onboarding navigation', async () => {
  const f = await fixture({ initialNativePage: 'support' });
  try {
    assert.equal(f.dom.window.document.querySelector('[data-view=support]').hidden, false);
    assert.equal(f.dom.window.document.querySelector('[data-view=setup]').hidden, true);
    assert.equal(f.calls.putConfig, 0);
    assert.equal(f.calls.testAgent, 0);
    assert.equal(f.calls.testModel, 0);
  } finally { f.close(); }
});

test('desktop uses configuration and journey from one status frame without a second getConfig request', async () => {
  const config = configFixture(); config.connectionChecks.model = { ok: true, checkedAt: 123456 };
  const f = await fixture({ config, dismissed: true, step: 'finish' });
  try {
    assert.equal(f.calls.getConfig, 0, 'home must not combine snapshot.journey with a separately fetched configuration');
    assert.equal(f.$('model-badge').textContent, '回答测试通过');
    f.api.getConfig = async () => { throw new Error('A second config request would mix status frames'); };
    f.config.markdown.dir = '/isolated/browser-selected-location';
    f.state.journey.notesVerified = true;
    f.state.readingStatus.sync = { completed: true, changed: true, at: 234567 };
    await f.ui.refresh();
    assert.equal(f.ui.state.journey.destination, destinationIdentity(f.config));
    assert.equal(f.$('notes-badge').dataset.state, 'ok');
    assert.equal(f.$('toast').hidden, true);
  } finally { f.close(); }
});

test('desktop status push updates browser-completed AI and sync immediately without four-second polling', async () => {
  const f = await fixture({ dismissed: true, step: 'finish' });
  try {
    assert.equal(f.listeners.size, 1, 'renderer subscribes to desktop state changes');
    const before = f.calls.status;
    f.state.readingStatus.ai = { verified: true, lastAnswerAt: 234567 };
    f.state.readingStatus.sync = { completed: true, changed: true, at: 234568 };
    f.state.journey.notesVerified = true;
    await f.push();
    assert.ok(f.calls.status > before);
    assert.equal(f.$('model-badge').textContent, '已完成网页回答');
    assert.equal(f.$('model-badge').dataset.state, 'ok');
    assert.equal(f.$('notes-badge').dataset.state, 'ok');
    f.ui.dispose();
    assert.equal(f.listeners.size, 0, 'dispose removes the native listener');
    assert.equal(f.calls.unsubscribe, 1);
  } finally { f.close(); }
});

test('a status push arriving during a refresh is replayed instead of leaving the older frame visible', async () => {
  const f = await fixture({ dismissed: true, step: 'finish' });
  try {
    const readStatus = f.desktop.status;
    const oldFrame = await readStatus();
    let release, first = true;
    f.desktop.status = async () => {
      if (first) { first = false; return new Promise(resolve => { release = () => resolve(oldFrame); }); }
      return readStatus();
    };
    const pending = f.ui.refresh(); await tick();
    assert.equal(typeof release, 'function');
    f.state.readingStatus.ai = { verified: true, lastAnswerAt: 456789 };
    for (const callback of [...f.listeners]) callback();
    release(); await pending; await tick();
    assert.equal(f.$('model-badge').textContent, '已完成网页回答');
  } finally { f.close(); }
});

test('legacy desktop status without embedded configuration still loads the shared service configuration', async () => {
  const config = configFixture(); config.connectionChecks.model = { ok: true, checkedAt: 123456 };
  const f = await fixture({ config, dismissed: true, step: 'finish', snapshotConfiguration: false });
  try {
    assert.ok(f.calls.getConfig >= 1);
    assert.equal(f.$('model-badge').textContent, '回答测试通过');
  } finally { f.close(); }
});

test('external status refresh preserves a focused unsaved Settings draft', async () => {
  const f = await fixture();
  try {
    const settings = f.ui.settings, field = settings.$('s-model');
    field.value = 'unsaved-local-choice'; field.dispatchEvent(new Event('input', { bubbles: true })); field.focus(); await tick();
    f.config.translate.model = 'saved-from-browser';
    f.config.connectionChecks.model = { ok: true, checkedAt: 345678 };
    await f.push();
    assert.equal(f.ui.settings, settings);
    assert.equal(field.value, 'unsaved-local-choice');
    assert.equal(settings.dirty, true);
    assert.equal(settings.sh.activeElement, field);
    assert.equal(f.calls.putConfig, 0);
  } finally { f.close(); }
});

test('selecting a discovered Agent remains a draft, without forcing a custom-path save before testing', async () => {
  const f = await fixture();
  try {
    f.$('agent-candidates').querySelector('button').click(); await tick();
    const settings = f.ui.settings;
    assert.equal(settings.$('s-agent').value, 'codex');
    assert.equal(settings.$('s-exBackend').value, 'agent');
    assert.equal(settings.$('s-agentExecutable').value, '', 'automatic discovery is not a custom executable override');
    assert.equal(settings.$('s-testAgent').disabled, false);
    assert.equal(f.calls.putConfig, 0); assert.equal(f.calls.testAgent, 0); assert.equal(f.calls.testModel, 0);
    assert.equal(settings.$('s-profileSafe').checked, true); assert.equal(settings.$('s-notesDir').value, '');
  } finally { f.close(); }
});

test('an explicit Agent test settling unlocks continue immediately without a native status push', async () => {
  const config = configFixture(); config.explain.backend = 'agent'; config.agent.id = 'codex';
  const f = await fixture({ config });
  try {
    assert.equal(f.$('setup-next').disabled, true);
    await f.ui.settings.testAgent(); await tick();
    assert.equal(f.calls.testAgent, 1);
    assert.equal(f.ui.settings.$('s-agentReady').textContent, '可用');
    assert.equal(f.$('setup-next').disabled, false, 'test settlement must notify the desktop shell');
    assert.equal(f.state.journey.step, 'tools', 'successful testing never advances without a user action');
  } finally { f.close(); }
});

test('a tested model draft becomes usable immediately after explicit save completes', async () => {
  const f = await fixture();
  try {
    const settings = f.ui.settings, field = settings.$('s-model');
    field.value = 'new-explicit-model'; field.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    await settings.modelAction('s-testModel', '测试中…', () => settings.testModel()); await tick();
    assert.equal(f.calls.testModel, 1); assert.equal(f.calls.putConfig, 0, 'testing is not implicit saving');
    assert.equal(settings.dirty, true);
    await settings.save(); await tick();
    assert.equal(f.calls.putConfig, 1); assert.equal(settings.dirty, false); assert.equal(settings.saving, false);
    assert.equal(settings.form.dataset.dirty, 'false');
    assert.equal(f.$('setup-next').disabled, false, 'saved tested configuration must not wait for a timer or focus change');
    assert.equal(f.state.journey.step, 'tools');
  } finally { f.close(); }
});

test('real browser writes validate only the matching destination, without duplicate desktop confirmation', () => {
  const config = configFixture(), base = { service: { state: 'running' }, pairings: [{ id: 'fixture' }],
    journey: { dismissed: true, destination: destinationIdentity(config), notesConfirmed: false, notesVerified: true },
    readingStatus: { ai: { verified: true, lastAnswerAt: 123456 }, sync: { completed: true, changed: true, at: 123457 } },
  };
  const result = productState(base, config);
  assert.equal(result.ai.ok, true); assert.equal(result.ai.answered, true); assert.equal(result.ai.label, '已完成网页回答');
  assert.equal(result.notes.confirmed, true); assert.equal(result.notes.verified, true);
  const changed = clone(config); changed.markdown.dir = '/isolated/new-destination';
  assert.equal(productState(base, changed).notes.verified, false, 'an old status frame cannot validate a new note location');
  assert.equal(productState(base, changed).notes.confirmed, false);
});

test('successful no-change sync is shown honestly without inventing a first real write', () => {
  const config = configFixture(), state = { service: { state: 'running' }, pairings: [{ id: 'fixture' }],
    journey: { dismissed: true, destination: destinationIdentity(config), notesConfirmed: false, notesVerified: false },
    readingStatus: { ai: { verified: false }, sync: { completed: true, changed: false, at: 123456 } },
  };
  const result = productState(state, config);
  assert.equal(result.ai.answered, false); assert.equal(result.ai.ok, false);
  assert.equal(result.notes.verified, false);
  assert.equal(result.notes.label, '同步完成 · 无新改动');
});
