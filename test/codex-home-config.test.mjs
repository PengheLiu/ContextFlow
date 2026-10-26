import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'contextflow-codex-home-config-'));
const previousDirectory = process.env.CONTEXTFLOW_DIR;
process.env.CONTEXTFLOW_DIR = directory;
const { loadConfig, saveConfig, publicView, CONFIG_PATH } = await import('../server/config.mjs');
if (previousDirectory === undefined) delete process.env.CONTEXTFLOW_DIR;
else process.env.CONTEXTFLOW_DIR = previousDirectory;
after(() => rmSync(directory, { recursive: true, force: true }));

test('public configuration exposes only the selected Codex directory and the actual default', () => {
  const cfg = loadConfig();
  cfg.agent = { ...cfg.agent, id: 'codex', env: { CODEX_HOME: '/fixture/Personal', SECRET: 'never-return' } };
  let view = publicView(cfg);
  assert.equal(view.agent.codexHome, '/fixture/Personal');
  assert.equal(view.agent.codexDefaultHome, process.env.CODEX_HOME || join(homedir(), '.codex'));
  assert.equal(JSON.stringify(view).includes('never-return'), false);
  assert.equal(Object.hasOwn(view.agent, 'env'), false);
  cfg.agent.id = 'claude'; view = publicView(cfg);
  assert.equal(view.agent.codexHome, '');
  cfg.agent.id = 'codex'; cfg.agent.env.CODEX_HOME = 7;
  assert.equal(publicView(cfg).agent.codexHome, '');
});

test('saving a Codex home normalizes it into env and clearing it preserves other same-CLI settings', () => {
  saveConfig({ agent: { id: 'codex', profile: 'safe', env: { HTTPS_PROXY: 'fixture-proxy' } } });
  const saved = saveConfig({ agent: { id: 'codex', codexHome: '~/Codex Profiles/Personal' } });
  assert.deepEqual(saved.agent.env, { HTTPS_PROXY: 'fixture-proxy', CODEX_HOME: join(homedir(), 'Codex Profiles/Personal') });
  assert.equal(Object.hasOwn(saved.agent, 'codexHome'), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).agent, 'codexHome'), false);
  assert.deepEqual(saveConfig({ agent: { codexHome: '' } }).agent.env, { HTTPS_PROXY: 'fixture-proxy' });
  assert.deepEqual(saveConfig({ agent: { id: 'codex', codexHome: '/fixture/other' } }).agent.env,
    { HTTPS_PROXY: 'fixture-proxy', CODEX_HOME: '/fixture/other' });
  assert.deepEqual(saveConfig({ agent: { id: 'claude' } }).agent.env, {}, 'another CLI cannot inherit a Codex login directory');
});

test('malformed or non-Codex directory updates reject atomically without changing configuration', () => {
  saveConfig({ agent: { id: 'codex', profile: 'safe', codexHome: '/fixture/saved' } });
  const before = readFileSync(CONFIG_PATH, 'utf8');
  for (const agent of [{ id: 'claude', codexHome: '/fixture/other' }, { codexHome: 1 }, { codexHome: null },
    { codexHome: 'relative/path' }, { codexHome: '/bad\npath' }, { codexHome: '/bad\0path' }, { codexHome: '/' + 'x'.repeat(4096) }]) {
    assert.throws(() => saveConfig({ agent }), error => error.code === 'BAD_AGENT_HOME');
    assert.equal(readFileSync(CONFIG_PATH, 'utf8'), before);
  }
  assert.equal(Object.hasOwn(saveConfig({ agent: { id: 'claude', codexHome: '' } }).agent, 'codexHome'), false);
});

test('native Codex picker accepts only an existing-directory purpose and never saves the selection', async () => {
  const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const body = source.match(/handler\('folder', async target => \{([\s\S]*?)\n  \}\);/)[1];
  const choose = new (Object.getPrototypeOf(async () => {}).constructor)('target', 'dialog', 'window', body);
  const calls = [], window = {}, dialog = { showOpenDialog: async (...args) => { calls.push(args); return { canceled: false, filePaths: ['/fixture/Personal'] }; } };
  assert.equal(await choose('codex-config', dialog, window), '/fixture/Personal');
  assert.equal(calls[0][0], window);
  assert.deepEqual(calls[0][1].properties, ['openDirectory']);
  assert.match(calls[0][1].title, /Codex/);
  await assert.rejects(choose('arbitrary-purpose', dialog, window), /无效的目录用途/);
  assert.equal(calls.length, 1);
  assert.equal(await choose('codex-config', { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, window), null);
});
