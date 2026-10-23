import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadingStatus } from '../server/reading-status.mjs';

const cfg = { explain: { backend: 'llm' }, translate: { provider: 'openai', baseUrl: 'https://model.private', model: 'm', apiKey: 'secret' },
  agent: { id: 'codex', executable: '/private/codex', profile: 'safe', notesDir: '/private/notes', env: { TOKEN: 'secret-env' } },
  sync: { backend: 'markdown' }, markdown: { dir: '/private/notes', folder: '/reading' } };
test('actual answers validate only their own configuration; cached/degraded answers cannot validate an Agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'contextflow-reading-status-'));
  try {
    const status = new ReadingStatus(root, 'service-secret', { now: () => 123 });
    assert.equal(status.answer(cfg, { answer: 'private answer', via: 'llm', cached: true }), false);
    assert.equal(status.view(cfg).ai.verified, false);
    assert.equal(status.answer(cfg, { answer: 'private answer', via: 'llm', cached: false }), true);
    assert.equal(status.view(cfg).ai.verified, true);
    const agentCfg = { ...cfg, explain: { backend: 'agent' } };
    assert.equal(status.view(agentCfg).ai.verified, false);
    status.answer(agentCfg, { answer: 'degraded', via: 'llm', cached: false });
    assert.equal(status.view(agentCfg).ai.verified, false);
    status.answer(agentCfg, { answer: 'agent answer', via: 'agent:codex', cached: false });
    assert.equal(new ReadingStatus(root, 'service-secret').view(agentCfg).ai.verified, true);
    for (const patch of [{ executable: '/other' }, { profile: 'full' }, { notesDir: '/other' }, { env: { TOKEN: 'changed' } }]) {
      assert.equal(status.view({ ...agentCfg, agent: { ...cfg.agent, ...patch } }).ai.verified, false);
    }
    assert.equal(status.view({ ...cfg, translate: { ...cfg.translate, apiKey: 'changed' } }).ai.verified, false);
    const text = readFileSync(join(root, 'reading-status.json'), 'utf8');
    for (const secret of ['/private/', 'private answer', 'secret-env', 'model.private']) assert.ok(!text.includes(secret));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a no-change sync gives immediate honest feedback without claiming a write; targets remain bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'contextflow-reading-sync-'));
  try {
    const status = new ReadingStatus(root, 'secret', { now: () => 456 });
    assert.equal(status.sync(cfg, { backend: 'markdown', articles: 0, files: [] }), true);
    assert.deepEqual(status.view(cfg).sync, { completed: true, changed: false, at: 456 });
    assert.equal(status.view({ ...cfg, markdown: { ...cfg.markdown, dir: '/other' } }).sync.completed, false);
    assert.equal(status.sync(cfg, { backend: 'siyuan', articles: 1, docs: ['private-doc'] }), false);
    status.sync(cfg, { backend: 'markdown', articles: 1, files: ['private-note'] });
    assert.equal(status.view(cfg).sync.changed, true);
    assert.ok(!readFileSync(join(root, 'reading-status.json'), 'utf8').includes('private-note'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
