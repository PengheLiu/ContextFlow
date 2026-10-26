import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { agentTestConfig, prepareAgentTest, testAgentConnection } from '../server/agent-test.mjs';
import { ConnectionChecks } from '../server/connection-checks.mjs';

test('Codex configuration directory is an unsaved draft, not another CLI credential or notes permission', async () => {
  const cfg = { agent: { id: 'dsh', profile: 'full', env: { SECRET: 'another-cli' }, notesDir: '/private/notes' } };
  const before = JSON.stringify(cfg);
  const draft = agentTestConfig({ id: 'codex', codexHome: '~/Codex Profiles/Personal', profile: 'safe' }, cfg);
  assert.deepEqual(draft.agent.env, { CODEX_HOME: join(homedir(), 'Codex Profiles/Personal') });
  let detected, executed;
  const prepared = await prepareAgentTest('codex', draft, async (_fresh, configured) => {
    detected = configured;
    return [{ id: 'codex', label: 'Codex CLI', available: true, path: '/fixture/codex', version: 'fixture', safeSupport: 'verified' }];
  });
  await testAgentConnection(prepared, { run: async options => { executed = options; return { answer: 'OK' }; } });
  assert.deepEqual(detected.env, draft.agent.env); assert.deepEqual(executed.env, draft.agent.env);
  assert.equal(executed.notesDir, ''); assert.equal(executed.profile, 'safe'); assert.equal(executed.connectionTest, true);
  assert.equal(JSON.stringify(cfg), before);
});

test('changing or clearing only the Codex directory preserves same-CLI credentials and does not mutate saved configuration', () => {
  const cfg = { agent: { id: 'codex', env: { CODEX_HOME: '/saved/profile', HTTPS_PROXY: 'private-proxy' }, profile: 'safe' } };
  const changed = agentTestConfig({ id: 'codex', codexHome: '/new/profile' }, cfg);
  assert.deepEqual(changed.agent.env, { CODEX_HOME: '/new/profile', HTTPS_PROXY: 'private-proxy' });
  const cleared = agentTestConfig({ id: 'codex', codexHome: '' }, cfg);
  assert.deepEqual(cleared.agent.env, { HTTPS_PROXY: 'private-proxy' });
  assert.equal(cfg.agent.env.CODEX_HOME, '/saved/profile');
  assert.deepEqual(agentTestConfig({ id: 'codex' }, cfg).agent.env, cfg.agent.env, 'older clients retain an existing directory');
  for (const body of [{ id: 'dsh', codexHome: '/profile' }, { id: 'codex', codexHome: 1 }, { id: 'codex', codexHome: 'relative/path' },
    { id: 'codex', codexHome: '/bad\npath' }, { id: 'codex', codexHome: '/' + 'x'.repeat(4096) }]) {
    assert.throws(() => agentTestConfig(body, cfg), error => error.code === 'BAD_AGENT_HOME');
  }
});

test('test receipts belong to the selected Codex directory and cannot turn another profile green', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextflow-codex-profile-checks-'));
  try {
    const checks = new ConnectionChecks(dir, 'isolated-fixture-secret');
    const installed = [{ id: 'codex', label: 'Codex CLI', path: '/fixture/codex', version: 'fixture', available: true, safeSupport: 'verified' }];
    const cfg = { translate: {}, agent: { id: 'codex', profile: 'safe', env: { CODEX_HOME: '/one/profile' } } };
    const prepared = await prepareAgentTest('codex', cfg, async () => installed);
    checks.finish(checks.begin(checks.agentKey(prepared)), true);
    assert.equal(checks.view(cfg, installed).agents.codex.ok, true);
    const changed = agentTestConfig({ id: 'codex', codexHome: '/another/profile' }, cfg);
    assert.equal(checks.view(changed, installed).agents.codex, undefined);
    assert.equal(checks.view(cfg, installed).agents.codex.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
