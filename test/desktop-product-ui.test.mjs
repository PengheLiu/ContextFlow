import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { productState, noteDestination } from '../desktop/ui/product-state.js';
import { startDesktopUI } from '../desktop/ui/renderer.js';
import { destinationIdentity } from '../src/core/destination.js';

const html = readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
const initialConfig = () => ({
  translate: { provider: 'openai', model: '', baseUrl: '', apiKeySet: false, target: '简体中文', chunkChars: 5000 },
  explain: { backend: 'llm' }, agent: { id: '', executable: '', notesDir: '', profile: 'safe', profileSource: 'new-default' },
  sync: { backend: 'markdown' }, markdown: { dir: '/isolated/ContextFlow', folder: '/阅读记录' },
  obsidian: { vaultPath: '', folder: '/阅读记录' }, siyuan: { origin: 'http://127.0.0.1:6806', notebookId: '', tokenSet: false }, connectionChecks: {},
});
const initialStatus = () => ({ version: '1.0.0', platform: 'darwin', architecture: 'arm64', service: { state: 'running', message: '本地服务已就绪' },
  pairings: [], preferences: { openAtLogin: false }, bridgeReady: true, packaged: true, updates: { state: 'idle', message: '手动检查更新' }, recoveryPoints: [],
  journey: { step: 'connect', dismissed: false, notesConfirmed: false, notesVerified: false },
  discovery: { agents: { state: 'done', items: [] }, notes: { state: 'done', items: [] } },
});
const tick = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setTimeout(resolve, 0)); };
async function fixture({ state = initialStatus(), config = initialConfig(), actionError } = {}) {
  state.journey.destination = destinationIdentity(config);
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://desktop.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event']) globalThis[key] = dom.window[key];
  const calls = [], actions = [], progress = [], recoveries = [];
  const api = {
    getConfig: async () => structuredClone(config),
    putConfig: async patch => { calls.push(patch); for (const [key, value] of Object.entries(patch)) config[key] = { ...config[key], ...value }; return structuredClone(config); },
    listFolders: async () => ({ root: '/isolated', folders: ['/阅读记录'] }), listVaults: async () => ({ vaults: state.discovery.notes.items }),
    health: async () => ({ serviceVersion: '1.0.0', capabilities: ['llm.draft', 'agent.test', 'connection.checks'] }),
    detectAgents: async () => ({ agents: state.discovery.agents.items, connectionChecks: config.connectionChecks }),
  };
  const desktop = {
    status: async () => structuredClone(state), request: async () => { throw new Error('Unexpected network request'); },
    onboarding: async patch => {
      progress.push(patch);
      if (patch.notesConfirmed && patch.expectedDestination !== destinationIdentity(config)) throw new Error('笔记位置已变化，请重新核对后确认。');
      const { expectedDestination, ...value } = patch; Object.assign(state.journey, value); state.journey.destination = destinationIdentity(config); return structuredClone(state.journey);
    },
    action: async name => { actions.push(name); if (actionError) throw new Error(actionError); return true; }, discover: async () => state.discovery,
    chooseFolder: async () => '/isolated/explicit-folder', chooseAgent: async () => '/isolated/agent',
    preferences: async patch => Object.assign(state.preferences, patch), revoke: async () => { state.pairings = []; },
    updates: async () => { throw new Error('预览版不检查正式更新'); }, recovery: async (...args) => { recoveries.push(args); return true; },
  };
  const ui = startDesktopUI({ desktop, serviceAPI: api, root: dom.window.document, poll: false }); await ui.ready; await tick();
  return { dom, ui, state, config, calls, actions, progress, recoveries, $: id => dom.window.document.getElementById(id),
    close() { ui.dispose(); dom.window.close(); },
  };
}

test('running core and discovered programs do not imply AI, note or browser readiness', () => {
  const state = initialStatus(); state.discovery.agents.items = [{ id: 'codex', available: true }];
  const result = productState(state, initialConfig());
  assert.equal(result.browser.ok, false); assert.equal(result.ai.ok, false); assert.equal(result.notes.confirmed, false); assert.equal(result.notes.verified, false);
  assert.equal(result.action.kind, 'browser'); assert.equal(result.notes.label, '尚未确认位置');
});
test('successful model check, explicit location confirmation and actual sync remain separate', () => {
  const state = initialStatus(), cfg = initialConfig(); cfg.connectionChecks.model = { ok: true }; state.journey.notesConfirmed = true; state.journey.destination = destinationIdentity(cfg);
  let result = productState(state, cfg); assert.equal(result.ai.ok, true); assert.equal(result.notes.confirmed, true); assert.equal(result.notes.verified, false);
  state.journey.notesVerified = true; result = productState(state, cfg); assert.equal(result.notes.verified, true);
  cfg.explain.backend = 'agent'; cfg.agent.id = 'codex'; result = productState(state, cfg); assert.equal(result.ai.ok, false, 'LLM success must not validate an untested Agent');
  state.service.state = 'stopped'; result = productState(state, cfg); assert.equal(result.ai.ok, false); assert.equal(result.notes.verified, false);
});
test('a new configuration cannot inherit confirmation or sync success from a stale status frame', () => {
  const state = initialStatus(), cfg = initialConfig(); state.journey.notesConfirmed = true; state.journey.notesVerified = true;
  state.journey.destination = destinationIdentity(cfg); assert.equal(productState(state, cfg).notes.verified, true);
  cfg.markdown.dir = '/isolated/different-location';
  assert.equal(productState(state, cfg).notes.confirmed, false); assert.equal(productState(state, cfg).notes.verified, false);
  delete state.journey.destination; assert.equal(productState(state, cfg).notes.confirmed, false);
});
test('startup is neutral and optional skipped AI does not prevent basic reading', () => {
  const state = initialStatus(); state.service.state = 'starting';
  assert.equal(productState(state).action.kind, 'none'); assert.equal(productState(state).preparing, true);
  state.service.state = 'running'; state.pairings = [{ id: 'fixture' }]; state.journey.dismissed = true; state.journey.notesConfirmed = true;
  state.journey.destination = destinationIdentity(initialConfig());
  assert.equal(productState(state, initialConfig()).action.kind, 'practice');
  assert.equal(noteDestination({ sync: { backend: 'obsidian' }, obsidian: {} }), null);
});
test('four daily destinations have consistent SVG icons; service controls are not on home', async () => {
  const f = await fixture();
  try {
    const nav = [...f.dom.window.document.querySelectorAll('nav [data-page]')];
    assert.deepEqual(nav.map(button => button.textContent), ['首页', 'AI 助手', '笔记', '设置与帮助']);
    for (const button of nav) { assert.ok(button.querySelector('svg')); assert.ok(button.getAttribute('aria-label')); }
    assert.equal(f.dom.window.document.querySelector('[data-view=home] [data-action=start]'), null);
    assert.equal(f.$('service-controls').open, false);
    assert.equal(f.dom.window.document.querySelector('[data-view=setup]').hidden, false);
  } finally { f.close(); }
});
test('onboarding can skip, return, defer and resume its persisted step without claiming success', async () => {
  const f = await fixture();
  try {
    assert.equal(f.$('setup-next').disabled, true);
    f.$('setup-skip').click(); await tick(); assert.equal(f.state.journey.step, 'tools');
    assert.equal(f.ui.settings.$('s-agent').value, '');
    f.$('setup-back').click(); await tick(); assert.equal(f.state.journey.step, 'connect');
    f.$('setup-skip').click(); await tick(); f.$('defer-setup').click(); await tick();
    assert.equal(f.state.journey.dismissed, true); assert.equal(f.state.journey.step, 'tools');
    assert.equal(f.$('model-badge').textContent, '尚未验证');
    f.$('resume-setup').click(); await tick(); assert.equal(f.state.journey.step, 'tools'); assert.equal(f.state.journey.dismissed, false);
    assert.ok(f.progress.length >= 5); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('one Settings instance preserves unsaved drafts between AI, notes and background refresh', async () => {
  const f = await fixture();
  try {
    await f.ui.page('ai'); const settings = f.ui.settings;
    assert.equal(settings.form.dataset.dirty, 'false');
    settings.$('s-model').value = 'unsaved-model'; settings.$('s-model').dispatchEvent(new Event('input', { bubbles: true }));
    settings.$('s-model').focus(); await f.ui.refresh(); assert.equal(settings.sh.activeElement?.id, 's-model');
    await f.ui.page('notes'); assert.equal(f.ui.settings, settings);
    assert.equal(settings.$('s-chapter-translate').hidden, true); assert.equal(settings.$('s-chapter-archive').hidden, false);
    f.config.translate.model = 'changed-elsewhere'; await f.ui.refresh();
    await f.ui.page('ai', { force: true });
    assert.equal(settings.$('s-model').value, 'unsaved-model'); assert.equal(f.calls.length, 0);
    assert.equal(settings.form.dataset.dirty, 'true');
    assert.equal(settings.$('s-chapter-archive').hidden, true); assert.match(f.$('draft-note').textContent, /未保存/);
  } finally { f.close(); }
});
test('discovered Agent stays unselected until explicit click; selection fills but never saves, tests or grants', async () => {
  const state = initialStatus(); state.discovery.agents.items = [{ id: 'codex', label: 'Codex CLI', available: true, path: '/isolated/codex', version: 'fixture', safeSupport: 'verified' }];
  const f = await fixture({ state });
  try {
    await f.ui.page('ai'); assert.equal(f.ui.settings.$('s-agent').value, ''); assert.equal(f.ui.settings.$('s-exBackend').value, 'llm');
    f.$('agent-candidates').querySelector('button').click(); await tick();
    assert.equal(f.ui.settings.$('s-agent').value, 'codex'); assert.equal(f.ui.settings.$('s-agentExecutable').value, '');
    assert.equal(f.ui.settings.$('s-profileSafe').checked, true); assert.equal(f.ui.settings.$('s-notesDir').value, '');
    assert.equal(f.calls.length, 0); assert.match(f.$('toast-message').textContent, /先测试.*保存/);
  } finally { f.close(); }
});
test('note candidates and native picker only fill shared fields; defaults need explicit saved-location confirmation', async () => {
  const state = initialStatus(); state.discovery.notes.items = [{ backend: 'obsidian', name: '<img src=x>', path: '/isolated/vault' }];
  const f = await fixture({ state });
  try {
    await f.ui.page('notes'); assert.equal(f.$('notes-badge').textContent, '尚未确认位置'); assert.equal(f.$('confirm-notes').disabled, false);
    assert.equal(f.$('note-confirmation').dataset.state, 'pending', '未确认位置不能使用验证成功的视觉状态');
    f.$('confirm-notes').click(); await tick(); assert.equal(f.state.journey.notesConfirmed, true); assert.equal(f.state.journey.notesVerified, false);
    assert.equal(f.$('notes-badge').textContent, '位置已确认 · 待同步');
    assert.equal(f.$('note-confirmation').dataset.state, 'confirmed', '位置确认与真实写入区分');
    f.$('note-candidates').querySelector('button').click(); await tick();
    assert.equal(f.ui.settings.$('s-vaultPath').value, '/isolated/vault'); assert.equal(f.$('note-candidates').querySelector('img'), null);
    assert.equal(f.$('confirm-notes').disabled, true); assert.equal(f.calls.length, 0);
    assert.equal(f.$('note-confirmation').dataset.state, 'pending', '未保存的目的地草稿不继承已确认视觉');
    await f.ui.page('ai'); const picker = f.ui.settings.$('s-notesDir').nextElementSibling; picker.click(); await tick();
    assert.equal(f.ui.settings.$('s-notesDir').value, '/isolated/explicit-folder'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('a stale enabled next button cannot advance after a saved note location is edited', async () => {
  const state = initialStatus(); state.journey = { ...state.journey, step: 'notes', notesConfirmed: true };
  const f = await fixture({ state });
  try {
    const field = f.ui.settings.$('s-mdDir'); field.value = '/isolated/unsaved'; field.dispatchEvent(new Event('input', { bubbles: true }));
    f.$('setup-next').disabled = false; f.$('setup-next').click(); await tick();
    assert.equal(f.state.journey.step, 'notes'); assert.match(f.$('toast-message').textContent, /先完成当前步骤/);
  } finally { f.close(); }
});
test('confirmation sends the viewed destination and refuses a concurrent external change', async () => {
  const f = await fixture();
  try {
    await f.ui.page('notes'); const viewed = destinationIdentity(f.config);
    f.config.markdown.dir = '/isolated/external-change';
    f.$('confirm-notes').click(); await tick();
    assert.equal(f.progress[0].expectedDestination, viewed); assert.equal(f.state.journey.notesConfirmed, false);
    assert.match(f.$('toast-message').textContent, /位置已变化/);
  } finally { f.close(); }
});
test('support errors and test feedback remain visible across refresh until explicitly dismissed', async () => {
  const f = await fixture({ actionError: '官网暂时无法打开，请稍后重试。' });
  try {
    f.dom.window.document.querySelector('[data-action=download]').click(); await tick();
    assert.match(f.$('toast-message').textContent, /官网暂时无法打开/); await f.ui.refresh(); assert.equal(f.$('toast').hidden, false); assert.equal(f.$('toast').getAttribute('role'), 'alert');
    await f.ui.page('ai'); f.ui.settings.msg('固定反馈', false); assert.equal(f.ui.settings.toastTimer, undefined); assert.equal(f.ui.settings.messageTimer, undefined);
    f.$('dismiss-toast').click(); assert.equal(f.$('toast').hidden, true);
    assert.match(readFileSync(new URL('../desktop/ui/styles.css', import.meta.url), 'utf8'), /prefers-reduced-motion/);
    assert.match(readFileSync(new URL('../desktop/ui/styles.css', import.meta.url), 'utf8'), /max-width:820px/);
  } finally { f.close(); }
});

test('desktop update opens the official download page without stopping services or invoking an installer', async () => {
  const f = await fixture();
  try {
    await f.ui.page('support');
    f.dom.window.document.querySelector('[data-action=download]').click(); await tick();
    assert.deepEqual(f.actions, ['download']);
    assert.equal(f.dom.window.document.querySelector('[data-update]'), null);
    assert.equal(f.state.service.state, 'running');
    assert.match(f.dom.window.document.querySelector('[data-view=support]').textContent, /任务.*退出旧版.*覆盖安装/);
    const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(main, /quitAndInstall|from ['"]electron-updater['"]/);
    assert.equal(JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url))).dependencies?.['electron-updater'], undefined);
  } finally { f.close(); }
});

test('A failed core retains the support and existing recovery actions without mounting settings', async () => {
  const state = initialStatus(); state.service = { state: 'error', message: '系统密钥无法读取，原文件已保留。' }; state.journey.dismissed = true;
  state.startupWarning = '启动偏好暂不可用，原文件保留。';
  state.recoveryPoints = [{ id: 'fixture-verified-point', createdAt: Date.now(), appVersion: 'fixture' }];
  const f = await fixture({ state });
  try {
    assert.equal(f.ui.settings, undefined); assert.equal(f.$('home-primary').disabled, false);
    assert.match(f.$('toast-message').textContent, /启动偏好/); assert.equal(f.$('create-recovery').disabled, true);
    f.$('home-primary').click(); await tick();
    assert.equal(f.dom.window.document.querySelector('[data-view=support]').hidden, false);
    assert.match(f.$('service-message').textContent, /密钥/);
    const restore = f.$('recovery-points').querySelector('button'); assert.equal(restore.disabled, false);
    restore.click(); await tick(); assert.deepEqual(f.recoveries, [['restore', 'fixture-verified-point']]);
    assert.equal(f.calls.length, 0, 'failed startup cannot silently save a default configuration');
  } finally { f.close(); }
});
