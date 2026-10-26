import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect } from '../server/agent.mjs';
import { ConnectionChecks, AGENT_EXECUTION_IDENTITY } from '../server/connection-checks.mjs';
import { ReadingStatus } from '../server/reading-status.mjs';
import { prepareAgentTest, testAgentConnection } from '../server/agent-test.mjs';
import { productState } from '../desktop/ui/product-state.js';
import { JSDOM } from 'jsdom';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cf-codex-readiness-')), bin = join(root, 'bin'), home = join(root, 'profile');
  mkdirSync(bin); mkdirSync(home);
  const previous = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'CONTEXTFLOW_DSH_BIN'].map(key => [key, process.env[key]]));
  for (const name of ['codex', 'claude', 'dsh', 'gemini']) { const path = join(bin, name); writeFileSync(path, `#!${process.execPath}\nconsole.log('fixture-cli 1');\n`); chmodSync(path, 0o755); }
  Object.assign(process.env, { PATH: bin, HOME: root, CODEX_HOME: home, CONTEXTFLOW_DSH_BIN: join(bin, 'dsh') });
  writeFileSync(join(home, 'config.toml'), 'model="PRIVATE_MODEL_ONE"\n'); writeFileSync(join(home, 'auth.json'), '{"token":"PRIVATE_AUTH_ONE"}');
  const cfg = { explain: { backend: 'agent' }, translate: {}, sync: { backend: 'markdown' },
    agent: { id: 'codex', executable: join(bin, 'codex'), profile: 'safe', notesDir: '', env: { CODEX_HOME: home } } };
  return { root, home, cfg, async installed() { return (await detect(false, cfg.agent)).find(row => row.id === 'codex'); },
    cleanup() { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); } };
}
const supported = process.platform !== 'win32' && !/\s/.test(process.execPath);

test('real discovery invalidates test and answer receipts after either Codex config or auth metadata changes', { skip: !supported }, async () => {
  const f = fixture();
  try {
    const checks = new ConnectionChecks(f.root, 'fixture-key'), status = new ReadingStatus(f.root, 'fixture-key', { now: () => 100 });
    let row = await f.installed();
    for (const [file, value] of [['config.toml', 'model="PRIVATE_MODEL_TWO_LONGER"\n'], ['auth.json', '{"token":"PRIVATE_AUTH_REPLACED_LONGER"}']]) {
      checks.finish(checks.begin(checks.agentKey({ ...row, profile: 'safe', env: f.cfg.agent.env })), true, 100);
      status.answer(f.cfg, { via: 'agent:codex', answer: 'private fixture answer', [AGENT_EXECUTION_IDENTITY]: row });
      assert.equal(checks.view(f.cfg, [row]).agents.codex.ok, true);
      writeFileSync(join(f.home, file), value); const after = await f.installed();
      assert.equal(after.path, row.path); assert.equal(after.version, row.version); assert.notEqual(after.identity, row.identity);
      assert.equal(checks.view(f.cfg, [after]).agents.codex, undefined);
      assert.equal(status.view(f.cfg, [after]).ai.verified, false); row = after;
    }
    for (const file of ['connection-checks.json', 'reading-status.json']) assert.doesNotMatch(readFileSync(join(f.root, file), 'utf8'), /PRIVATE_|cf-codex-readiness|private fixture/);
  } finally { f.cleanup(); }
});

test('a service restart with another effective default Codex home cannot borrow an old receipt', { skip: !supported }, async () => {
  const f = fixture();
  try {
    f.cfg.agent.env = {};
    const checks = new ConnectionChecks(f.root, 'fixture-key'), before = await f.installed();
    checks.finish(checks.begin(checks.agentKey({ ...before, profile: 'safe', env: {} })), true);
    const second = join(f.root, 'second-default'); mkdirSync(second); process.env.CODEX_HOME = second;
    const after = await f.installed(); assert.notEqual(after.identity, before.identity);
    assert.equal(new ConnectionChecks(f.root, 'fixture-key').view(f.cfg, [after]).agents.codex, undefined);
    delete process.env.CODEX_HOME; const fallback = await f.installed(); assert.notEqual(fallback.identity, after.identity);
    assert.equal(new ConnectionChecks(f.root, 'fixture-key').view(f.cfg, [fallback]).agents.codex, undefined);
    f.cfg.agent.env.CODEX_HOME = f.home;
    const explicit = await f.installed(); process.env.HOME = second;
    assert.notEqual((await f.installed()).identity, explicit.identity, 'the effective HOME is bound even when CODEX_HOME is explicit');
  } finally { f.cleanup(); }
});

test('config edits or CLI login refreshes during a successful short response must be tested again', { skip: !supported }, async () => {
  const f = fixture();
  try {
    for (const file of ['config.toml', 'auth.json']) {
      const prepared = await prepareAgentTest('codex', f.cfg);
      await assert.rejects(() => testAgentConnection(prepared, { run: async () => {
        writeFileSync(join(f.home, file), `PRIVATE_CHANGED_DURING_${file}_${Date.now()}`); return { answer: 'OK' };
      } }), error => error.code === 'AGENT_CONFIGURATION_CHANGED' && /重新测试/.test(error.message) && !/PRIVATE_CHANGED/.test(error.message));
    }
  } finally { f.cleanup(); }
});

test('all newly classified real answering failures revoke older green status; cancellation and bad input do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-readiness-classified-'));
  try {
    let now = 100;
    const cfg = { explain: { backend: 'agent' }, translate: {}, agent: { id: 'codex', profile: 'safe', env: {} } };
    const row = { id: 'codex', path: '/fixture/codex', identity: 'opaque-fixture', version: 'v1', available: true };
    const status = new ReadingStatus(root, 'fixture-key', { now: () => now });
    const config = { ...cfg, connectionChecks: { agents: { codex: { ok: true, checkedAt: 1 } } } };
    for (const code of ['AGENT_MODEL_UNAVAILABLE', 'AGENT_REASONING_UNSUPPORTED', 'AGENT_QUOTA', 'AGENT_RATE_LIMIT', 'AGENT_NETWORK', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_ACCESS_DENIED', 'AGENT_PROVIDER_REQUEST', 'CODEX_RPC']) {
      now++; status.answer(cfg, { via: 'agent:codex', answer: 'fixture answer', [AGENT_EXECUTION_IDENTITY]: row }); now++;
      assert.equal(status.agentFailure(cfg, { code, [AGENT_EXECUTION_IDENTITY]: row }), true, code);
      const reading = status.view(cfg, [row], config.connectionChecks);
      assert.equal(reading.ai.verified, false, code);
      assert.equal(productState({ service: { state: 'running' }, readingStatus: reading }, config).ai.ok, false, code);
    }
    now++; status.answer(cfg, { via: 'agent:codex', answer: 'fixture answer', [AGENT_EXECUTION_IDENTITY]: row });
    for (const code of ['ABORTED', 'BAD_INPUT']) assert.equal(status.agentFailure(cfg, { code, [AGENT_EXECUTION_IDENTITY]: row }), false);
    assert.equal(status.view(cfg, [row]).ai.verified, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the actual settings UI binds local and restored tests to opaque installation identity and clears missing history', async () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'Event']) globalThis[name] = dom.window[name];
  const { Settings } = await import('../src/skill/settings.js');
  const sh = document.getElementById('host').attachShadow({ mode: 'open' }), mount = document.createElement('div'); sh.append(mount);
  const first = { id: 'codex', label: 'Codex CLI', path: '/fixture/codex', version: 'v1', identity: 'opaque-first', available: true, safeSupport: 'verified' };
  const next = { ...first, identity: 'opaque-next' };
  const settings = new Settings(sh, mount, { detectAgents: async () => ({ agents: [next] }) });
  settings.cfg = { agent: { id: 'codex', profile: 'safe', executable: '', codexHome: '/fixture/profile', codexDefaultHome: '/fixture/default' }, translate: {} };
  settings.wantAgent = 'codex'; settings.agents = [first]; settings.syncAgentSel(); settings.$('s-codexHome').value = '/fixture/profile';
  const checks = { agents: { codex: { ok: true, checkedAt: 100, profile: 'safe', path: first.path, version: first.version, identity: first.identity } } };
  settings.applyConnectionChecks(checks); assert.equal(settings.agentResult().ok, true);
  await settings.detectAgents(false); assert.equal(settings.agentResult(), null); assert.equal(settings.agentTests.size, 0);
  settings.applyConnectionChecks(checks); assert.equal(settings.agentResult(), null, 'an old saved receipt must not be relabeled with the new program/config identity');
  settings.applyConnectionChecks(undefined); assert.equal(settings.agentTests.size, 0); assert.equal(settings.modelTest, null);
  dom.window.close();
});
