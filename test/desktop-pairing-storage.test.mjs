import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { runInNewContext, createContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { browserPairingState, requireBrowserPairings, PAIRING_READ_ERROR } from '../desktop/pairing-state.mjs';
import { diagnosticReport } from '../desktop/diagnostics.mjs';
import { atomicJSON } from '../desktop/platform.mjs';
import { listPairings, pairExtension, extensionAuthorized } from '../server/extension-pairing.mjs';
import { createRecoveryPoint, listRecoveryPoints, applyRecoveryPoint } from '../desktop/recovery.mjs';
import { startDesktopUI } from '../desktop/ui/renderer.js';
import { productState } from '../desktop/ui/product-state.js';

const id = 'a'.repeat(32), instanceId = 'fixture-browser-instance-01';
const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-pairing-storage-'));
  const paths = { data: join(root, 'data'), state: join(root, 'state'), secret: join(root, 'state/secret-key.bin'), bridge: join(root, 'state/bridge.json') };
  mkdirSync(paths.data); mkdirSync(paths.state);
  return { root, paths, file: join(paths.data, 'extension-pairings.json'), close: () => rmSync(root, { recursive: true, force: true }) };
};
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

test('invalid JSON or grant shapes stay fail-closed and never become an empty writable grant store', () => {
  const f = fixture();
  try {
    const invalid = ['{PRIVATE_BROKEN_RECORD', 'null', '[]', '1', '"PRIVATE_RECORD"', JSON.stringify({ [id]: null }),
      JSON.stringify({ [id]: {} }), JSON.stringify({ [id]: { futureMetadata: 'no actual grant or container' } }),
      JSON.stringify({ [id]: { instances: [] } }), JSON.stringify({ [id]: { instances: { [instanceId]: {} } } }),
      JSON.stringify({ [id]: { tokenHash: ['a'.repeat(64)] } }), JSON.stringify({ [id]: { tokenHash: 'invalid' } }),
      JSON.stringify({ [id]: { revoked: 'false' } })];
    for (const source of invalid) {
      writeFileSync(f.file, source);
      const state = browserPairingState(() => listPairings(f.paths.data));
      assert.equal(state.pairings, null); assert.equal(state.pairingError, PAIRING_READ_ERROR);
      assert.throws(() => requireBrowserPairings(() => listPairings(f.paths.data)), error => error.code === 'PAIRING_STORAGE_UNREADABLE' && !error.message.includes('PRIVATE'));
      assert.throws(() => pairExtension(id, { directory: f.paths.data, instanceId }), error => error.code === 'PAIRING_STORAGE_UNREADABLE');
      assert.throws(() => pairExtension(id, { directory: f.paths.data, revoke: true }), error => error.code === 'PAIRING_STORAGE_UNREADABLE');
      assert.equal(readFileSync(f.file, 'utf8'), source, 'failure never replaces or repairs a grant file implicitly');
    }
  } finally { f.close(); }
});

test('valid legacy and per-installation grants retain unknown metadata and independent revocation', () => {
  const f = fixture(), previous = process.env.CONTEXTFLOW_DIR; process.env.CONTEXTFLOW_DIR = f.paths.data;
  try {
    writeFileSync(f.file, JSON.stringify({ [id]: { instances: {}, futureMetadata: 'valid empty v2 container' } }));
    assert.deepEqual(listPairings(f.paths.data), []);
    const legacy = pairExtension(id, { directory: f.paths.data });
    const native = pairExtension(id, { directory: f.paths.data, instanceId });
    const saved = JSON.parse(readFileSync(f.file, 'utf8')); saved[id].futureMetadata = { label: 'keep this compatible field' };
    saved[id].instances[instanceId].futureMetadata = ['keep this too']; writeFileSync(f.file, JSON.stringify(saved));
    assert.equal(extensionAuthorized(`chrome-extension://${id}`, legacy), true);
    assert.equal(extensionAuthorized(`chrome-extension://${id}`, native, instanceId), true);
    const state = browserPairingState(() => listPairings(f.paths.data));
    assert.equal(state.pairingError, ''); assert.equal(state.pairings.length, 2);
    pairExtension(id, { directory: f.paths.data, revoke: true, legacyOnly: true });
    assert.equal(extensionAuthorized(`chrome-extension://${id}`, legacy), false);
    assert.equal(extensionAuthorized(`chrome-extension://${id}`, native, instanceId), true);
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8'))[id].instances[instanceId].futureMetadata, ['keep this too']);
  } finally { if (previous === undefined) delete process.env.CONTEXTFLOW_DIR; else process.env.CONTEXTFLOW_DIR = previous; f.close(); }
});

test('the real desktop state function still returns recovery and safe diagnostics with unreadable authorizations', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.paths.data, 'config.json'), '{}'); writeFileSync(join(f.paths.data, 'context.db'), 'fixture database bytes'); writeFileSync(f.paths.secret, 'fixture OS-sealed key');
    const point = await createRecoveryPoint(f.paths, { appVersion: 'fixture', sealConfig: value => value });
    const source = '{PRIVATE_BROKEN_RECORD'; writeFileSync(f.file, source);
    const code = main.slice(main.indexOf('async function state() {'), main.indexOf('  function systemIntegration()')) + '\nstate;';
    const readState = runInNewContext(code, { service: { snapshot: () => ({ state: 'error', message: 'Fixture core is stopped' }), lastHealth: null },
      app: { getVersion: () => '1.1.1', isPackaged: true }, paths: f.paths, process: { platform: 'darwin', arch: 'arm64' },
      listPairings, browserPairingState, bridgeReady: true, preferences: {}, updateState: {}, discovery: { snapshot: () => ({}) },
      journeyView: () => ({}), destinationKey: () => '', destinationIdentity: () => '', lastConfig: {}, systemIntegration: () => ({}), listRecoveryPoints, preferencesWarning: '' });
    const snapshot = await readState();
    assert.equal(snapshot.pairings, null); assert.equal(snapshot.pairingError, PAIRING_READ_ERROR);
    assert.equal(snapshot.recoveryPoints.length, 1); assert.equal(snapshot.recoveryPoints[0].id, point.id);
    const report = diagnosticReport(snapshot); assert.equal(report.pairingStorage, 'unreadable'); assert.equal(report.browserConnections, null);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|fixture database|OS-sealed|cf-pairing-storage/);
    await applyRecoveryPoint(f.paths, point.id);
    assert.equal(readFileSync(f.file, 'utf8'), source, 'ordinary recovery must not override browser authorization');
  } finally { f.close(); }
});

test('the real native bridge refuses a damaged grant store before opening approval or writing a grant', async () => {
  const f = fixture(); let bridge, approvals = 0, grants = 0;
  try {
    const source = '[]'; writeFileSync(f.file, source);
    const code = main.slice(main.indexOf('async function startBridge() {'), main.indexOf("  app.on('second-instance'")) + '\nstartBridge;';
    const context = createContext({ createServer, randomBytes, atomicJSON, paths: f.paths, identity: { build: 'fixture' },
      app: { getVersion: () => '1.1.1' }, process, systemIntegration: () => ({}), service: { state: 'running' },
      listPairings, requireBrowserPairings, preview: false, EXTENSIONS: [id], pairing: false,
      approveBrowserPairing: () => { approvals++; throw new Error('Approval must not open'); },
      pairExtension: () => { grants++; throw new Error('Grant must not be written'); }, show() {}, bridge: null });
    await runInNewContext(code, context)(); bridge = context.bridge;
    const descriptor = JSON.parse(readFileSync(f.paths.bridge, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/pair`, { method: 'POST', headers: { Authorization: `Bearer ${descriptor.secret}` }, body: JSON.stringify({ id, instanceId, label: 'Fixture browser' }) });
    const body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.code, 'PAIRING_STORAGE_UNREADABLE'); assert.equal(body.ok, false);
    assert.equal(body.error, PAIRING_READ_ERROR); assert.equal(approvals, 0); assert.equal(grants, 0);
    assert.equal(readFileSync(f.file, 'utf8'), source);
  } finally { bridge?.closeAllConnections(); if (bridge) await new Promise(resolve => bridge.close(resolve)); f.close(); }
});

test('home, onboarding and help expose the problem without hiding recovery or diagnostics', async () => {
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'https://desktop.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event']) globalThis[key] = dom.window[key];
  const actions = [], restores = [], cfg = { explain: { backend: 'llm' }, translate: { model: 'fixture' }, sync: { backend: 'markdown' }, markdown: {} };
  const state = { version: '1.1.1', platform: 'darwin', architecture: 'arm64', service: { state: 'error', message: 'Fixture stopped core' },
    pairings: null, pairingError: PAIRING_READ_ERROR, preferences: {}, bridgeReady: true, packaged: true, updates: {}, configuration: cfg,
    discovery: { agents: { state: 'done', items: [] }, notes: { state: 'done', items: [] } }, journey: { step: 'connect', dismissed: false },
    recoveryPoints: [{ id: 'fixture-point', createdAt: Date.now() }] };
  const ui = startDesktopUI({ root: dom.window.document, poll: false, serviceAPI: { getConfig: async () => cfg }, desktop: {
    status: async () => structuredClone(state), action: async name => { actions.push(name); return true; },
    recovery: async (...args) => { restores.push(args); return false; },
  } });
  const $ = id => dom.window.document.getElementById(id);
  try {
    await ui.ready; await tick();
    assert.equal(productState(state, cfg).browser.count, null); assert.equal(productState(state, cfg).browser.ok, false);
    assert.match($('setup-browser-status').textContent, /授权记录无法读取/); assert.equal($('setup-pairing-help').hidden, false);
    assert.equal($('setup-next').disabled, true); assert.match($('setup-next-hint').textContent, /授权记录需要处理/);
    $('setup-pairing-help').click(); await tick(); assert.equal($('pairing-repair-guide').open, true);
    await ui.page('home'); assert.equal($('browser-badge').textContent, '授权记录需处理'); assert.equal($('browser-badge').dataset.state, 'bad');
    assert.doesNotMatch($('browser-summary').textContent, /已授权 0|尚未授权/);
    $('home-primary').click(); await tick(); assert.equal($('pairing-repair-guide').hidden, false);
    assert.match($('pairings').textContent, /数量暂不可确认/);
    assert.equal($('recovery-points').querySelectorAll('button').length, 1);
    $('recovery-points').querySelector('button').click(); await tick(); assert.deepEqual(restores, [['restore', 'fixture-point']]);
    $('pairing-repair-guide').querySelector('[data-action=diagnostics]').click(); await tick(); assert.deepEqual(actions, ['diagnostics']);
    for (const button of dom.window.document.querySelectorAll('[data-action=browser]')) assert.equal(button.disabled, true);
    state.pairings = []; state.pairingError = ''; await ui.refresh();
    assert.equal($('pairing-repair-guide').hidden, true); assert.equal($('setup-pairing-help').hidden, true);
    assert.equal($('browser-badge').textContent, '尚未授权');
  } finally { ui.dispose(); dom.window.close(); }
});
